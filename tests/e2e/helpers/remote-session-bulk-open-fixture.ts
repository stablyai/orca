import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(fixturePath: string, marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

/**
 * Continuous remote-agent-like flood fixture for freeze repros.
 * Many remote sessions stream while the client bulk-opens them.
 * One-shot FLOOD is not enough — agents keep writing.
 */
export function createRemoteSessionBulkOpenFixture(): {
  command: (marker: string) => string
  dispose: () => void
} {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-remote-bulk-open-'))
  const fixturePath = path.join(scratch, 'remote-bulk-open-flood.mjs')
  writeFileSync(
    fixturePath,
    [
      'const marker = process.argv[2]',
      'process.stdout.write(`READY:${marker}\\r\\n`)',
      'process.stdin.setRawMode?.(true)',
      "process.stdin.setEncoding('utf8')",
      'let frame = 0',
      'let timer = null',
      "const chunk = 'A'.repeat(2048)",
      'function startFlood() {',
      '  if (timer) return',
      '  timer = setInterval(() => {',
      '    frame += 1',
      '    process.stdout.write(`BG:${marker}:${frame}:${chunk}\\r\\n`)',
      '  }, 8)',
      '}',
      'function stopFlood() {',
      '  if (timer) clearInterval(timer)',
      '  timer = null',
      '}',
      // Auto-start flood after ready so hidden tabs accumulate backlog.
      'setTimeout(startFlood, 200)',
      "process.stdin.on('data', (data) => {",
      '  for (const command of data.split(/\\r\\n|\\r|\\n/).filter(Boolean)) {',
      "    if (command === 'GO' || command === 'FLOOD') { startFlood(); continue }",
      "    if (command === 'STOP') { stopFlood(); process.stdout.write(`STOPPED:${marker}\\r\\n`); continue }",
      "    if (command === 'PING') { process.stdout.write(`PONG:${marker}:${frame}\\r\\n`); continue }",
      '    process.stdout.write(`LIVE:${marker}:${command}\\r\\n`)',
      '  }',
      '})',
      'process.stdin.resume()',
      "process.on('SIGINT', () => { stopFlood(); process.exit(0) })"
    ].join('\n')
  )
  return {
    command: (marker) => fixtureCommand(fixturePath, marker),
    dispose: () => rmSync(scratch, { recursive: true, force: true })
  }
}

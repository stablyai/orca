import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILL_ROWS = 6_000

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(fixturePath: string, marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

export function createPairedTerminalParkingFixture(): {
  command: (marker: string) => string
  dispose: () => void
} {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-retention-memory-'))
  const fixturePath = path.join(scratch, 'paired-retention-memory.mjs')
  writeFileSync(
    fixturePath,
    [
      'const marker = process.argv[2]',
      'process.stdout.write(`READY:${marker}\\r\\n`)',
      'process.stdin.setRawMode?.(true)',
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (data) => {",
      '  for (const command of data.split(/\\r\\n|\\r|\\n/).filter(Boolean)) {',
      "    if (command === 'FILL') {",
      `      for (let row = 0; row < ${FILL_ROWS}; row += 1) process.stdout.write(\`fill-${'${marker}'}-${'${row}'}-${'x'.repeat(80)}\\r\\n\`)`,
      '      process.stdout.write(`FILLED:${marker}\\r\\n`)',
      '      continue',
      '    }',
      '    process.stdout.write(`LIVE:${command}\\r\\n`)',
      '  }',
      '})',
      'process.stdin.resume()'
    ].join('\n')
  )
  return {
    command: (marker) => fixtureCommand(fixturePath, marker),
    dispose: () => rmSync(scratch, { recursive: true, force: true })
  }
}

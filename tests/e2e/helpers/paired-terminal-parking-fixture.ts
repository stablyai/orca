import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quotePosixShell } from '../../../src/shared/shell-argument-quoting'

const FILL_ROWS = 6_000
const FLOOD_ROWS = 4_000
const TITLE_FRAME_INTERVAL_MS = 70
const TITLE_FRAME_COUNT = 30
const TITLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function fixtureCommand(fixturePath: string, marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(quotePosixShell).join(' ')
}

export function createPairedTerminalParkingFixture(): {
  command: (marker: string) => string
  /** PTY grid the fixture saw at `SIZE:<token>`, read off disk so a parked pane needs no client. */
  readReportedSize: (marker: string, token: string) => string | null
  dispose: () => void
} {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-retention-memory-'))
  const fixturePath = path.join(scratch, 'paired-retention-memory.mjs')
  writeFileSync(
    fixturePath,
    [
      "import { writeFileSync } from 'node:fs'",
      'const marker = process.argv[2]',
      'process.stdout.write(`READY:${marker}\\r\\n`)',
      'process.stdin.setRawMode?.(true)',
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (data) => {",
      '  for (const command of data.split(/\\r\\n|\\r|\\n/).filter(Boolean)) {',
      "    if (command.startsWith('TITLE_START:')) {",
      "      const token = command.slice('TITLE_START:'.length)",
      "      process.stdout.write('\\u001b]0;⠋ Cursor Agent\\u0007')",
      '      process.stdout.write(`TITLE_STARTED:${token}\\r\\n`)',
      '      continue',
      '    }',
      "    if (command.startsWith('TITLE_ANIMATE:')) {",
      "      const token = command.slice('TITLE_ANIMATE:'.length)",
      `      const frames = ${JSON.stringify(TITLE_FRAMES)}`,
      '      let frameIndex = 0',
      '      const emitFrame = () => {',
      `        if (frameIndex < ${TITLE_FRAME_COUNT}) {`,
      '          process.stdout.write(`\\u001b]0;${frames[frameIndex % frames.length]} Cursor Agent\\u0007`)',
      '          frameIndex += 1',
      `          setTimeout(emitFrame, ${TITLE_FRAME_INTERVAL_MS})`,
      '          return',
      '        }',
      "        process.stdout.write('\\u001b]0;Cursor ready\\u0007')",
      '        process.stdout.write(`TITLE_DONE:${token}\\r\\n`)',
      '      }',
      `      setTimeout(emitFrame, ${TITLE_FRAME_INTERVAL_MS})`,
      '      continue',
      '    }',
      "    if (command.startsWith('FLOOD:')) {",
      "      const token = command.slice('FLOOD:'.length)",
      `      for (let row = 0; row < ${FLOOD_ROWS}; row += 1) process.stdout.write(\`flood-${'${token}'}-${'${row}'}-${'x'.repeat(80)}\\r\\n\`)`,
      '      process.stdout.write(`FLOODED:${token}\\r\\n`)',
      '      continue',
      '    }',
      "    if (command === 'FILL') {",
      `      for (let row = 0; row < ${FILL_ROWS}; row += 1) process.stdout.write(\`fill-${'${marker}'}-${'${row}'}-${'x'.repeat(80)}\\r\\n\`)`,
      '      process.stdout.write(`FILLED:${marker}\\r\\n`)',
      '      continue',
      '    }',
      "    if (command.startsWith('SIZE:')) {",
      "      const token = command.slice('SIZE:'.length)",
      '      writeFileSync(`${process.argv[1]}.${marker}.${token}.size`, `${process.stdout.columns}x${process.stdout.rows}`)',
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
    readReportedSize: (marker, token) => {
      const sizePath = `${fixturePath}.${marker}.${token}.size`
      return existsSync(sizePath) ? readFileSync(sizePath, 'utf8') : null
    },
    dispose: () => rmSync(scratch, { recursive: true, force: true })
  }
}

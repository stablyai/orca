import { basename } from 'node:path'
import type { nameDarwinTerminals } from './darwin-terminal-names'

export type PsFixtureRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  terminalMinor: number
  startTime: string
  startTicks: number
  command: string
}

/** One synthetic host supplies requested ps columns, /dev devices, and stable /proc starts. */
export function createProcessTablePsFixture(readRows: () => readonly PsFixtureRow[]) {
  function render(columns: string): string {
    const output = readRows()
      .map((row) =>
        columns
          .split(',')
          .map((column) => {
            switch (column) {
              case 'pid=':
                return row.pid
              case 'ppid=':
                return row.ppid
              case 'pgid=':
                return row.pgid
              case 'tpgid=':
                return row.tpgid
              case 'stat=':
                return row.stat
              case 'tdev=':
                return `16/${row.terminalMinor}`
              case 'tty=':
                return process.platform === 'darwin'
                  ? `ttys${String(row.terminalMinor).padStart(3, '0')}`
                  : `pts/${row.terminalMinor}`
              case 'lstart=':
                return row.startTime
              case 'etimes=':
                // Deliberate drift makes /proc the only stable Linux start marker.
                return String(100 + Math.floor(Date.now() / 1000))
              case 'command=':
                return row.command
              default:
                throw new Error(`unsupported fixture ps column: ${column}`)
            }
          })
          .join(' ')
      )
      .join('\n')
    return `${output}\n`
  }

  function readProcStat(path: string): string {
    const match = path.match(/^\/proc\/(\d+)\/stat$/)
    const row = match ? readRows().find((candidate) => candidate.pid === Number(match[1])) : null
    if (!row) {
      throw new Error(`no fixture process at ${path}`)
    }
    const start = String(row.startTicks)
    return `${row.pid} (fixture) ${['S', ...Array.from({ length: 18 }, () => '0'), start, '0'].join(' ')}`
  }

  function nameTerminals(
    translate: typeof nameDarwinTerminals,
    stdout: string,
    signal?: AbortSignal
  ) {
    const minors = new Set(readRows().map((row) => row.terminalMinor))
    return translate(
      stdout,
      {
        openDirectory: async () =>
          (async function* () {
            for (const minor of minors) {
              yield { name: `ttys${String(minor).padStart(3, '0')}` }
            }
          })(),
        readDevice: async (path: string) => ({
          rdev: (16n << 24n) | BigInt(basename(path).slice(4)),
          isCharacterDevice: () => true
        })
      },
      signal
    )
  }

  return { render, readProcStat, nameTerminals }
}

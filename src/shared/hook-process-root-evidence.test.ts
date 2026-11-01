import { describe, expect, it, vi } from 'vitest'
import {
  classifyHookProcessRoot,
  createHookRootEvidenceReader,
  type HookProcessVerdict
} from './hook-process-root-evidence'
import type { ProcessTableRow } from './process-table-snapshot'

const TTY = 'ttys004'

function row(
  pid: number,
  ppid: number,
  pgid: number,
  command: string,
  stat = 'S+',
  tpgid = 49969,
  tty = TTY
): ProcessTableRow {
  return { pid, ppid, pgid, tpgid, tty, stat, command }
}

// Orca's PTY host has no terminal; the pane shell leads the terminal session.
const host = row(90, 1, 90, '/Applications/Orca.app/Contents/MacOS/Orca', 'S', 0, '??')
const shell = row(100, 90, 100, '-zsh', 'Ss')
const claude = row(49969, 100, 49969, 'claude')
const toolShell = row(49975, 49969, 49969, '/bin/zsh -c claude -p "summarize"')
const nested = row(49980, 49975, 49969, 'claude -p summarize')
const background = row(49990, 100, 49990, 'claude -p "nightly report"', 'S')

describe('classifyHookProcessRoot', () => {
  it.each<[string, readonly ProcessTableRow[], number, HookProcessVerdict]>([
    ['the foreground agent under the pane shell', [host, shell, claude], 49969, 'root'],
    [
      'an agent behind a non-exec wrapper',
      [host, shell, row(49960, 100, 49960, 'npm exec claude'), row(49969, 49960, 49960, 'claude')],
      49969,
      'root'
    ],
    [
      'an agent exec-ed in place of the shell',
      [host, row(100, 90, 100, 'claude', 'Ss+', 100)],
      100,
      'root'
    ],
    [
      'a headless agent run by the pane agent',
      [host, shell, claude, toolShell, nested],
      49980,
      'nested'
    ],
    [
      'a background agent while the pane agent holds the foreground',
      [host, shell, claude, background],
      49990,
      'competing'
    ],
    [
      'a background agent while only the shell holds the foreground',
      [host, row(100, 90, 100, '-zsh', 'Ss+', 100), { ...background, tpgid: 100 }],
      49990,
      'root'
    ],
    ['a process missing from the table', [host, shell], 49969, 'unknown'],
    ['a process without a terminal', [host, shell, { ...claude, tty: '??' }], 49969, 'unknown'],
    [
      'a process whose lineage leaves its terminal session',
      [host, { ...claude, ppid: 90 }],
      49969,
      'unknown'
    ],
    [
      'an ancestor whose argv was unreadable',
      [host, shell, row(49960, 100, 49969, '(node)'), { ...claude, ppid: 49960 }],
      49969,
      'unknown'
    ]
  ])('reads %s', (_name, rows, pid, verdict) => {
    expect(classifyHookProcessRoot(rows, pid)).toBe(verdict)
  })
})

describe('createHookRootEvidenceReader', () => {
  const identity = {
    pid: 49969,
    platform: 'darwin' as const,
    startTime: 'Sun Nov  1 00:01:23 2026'
  }

  it('reads the table only for a live, start-matched process and shares concurrent reads', async () => {
    const readTable = vi.fn(async () => [host, shell, claude])
    const probe = vi.fn(async () => 'live' as const)
    const read = createHookRootEvidenceReader({ probe, readTable })
    const verdicts = await Promise.all([read(identity), read(identity), read(identity)])
    expect(verdicts).toEqual(['root', 'root', 'root'])
    expect(probe).toHaveBeenCalledOnce()
    expect(readTable).toHaveBeenCalledOnce()
    probe.mockResolvedValueOnce('exited')
    expect(await read(identity)).toBe('unknown')
    expect(readTable).toHaveBeenCalledOnce()
    readTable.mockRejectedValueOnce(new Error('capture_over_budget'))
    expect(await read(identity)).toBe('unknown')
  })
})

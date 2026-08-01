import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
type ExecCallback = (error: unknown, result: { stdout: string; stderr: string }) => void

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import type { ProcessTableRow } from './process-table-snapshot'
import { isTmuxSessionCommand, resolveTmuxPaneForegroundProcess } from './tmux-pane-process'

function row(pid: number, ppid: number, stat: string, command: string): ProcessTableRow {
  return { pid, ppid, stat, command }
}

describe('tmux pane process resolution', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('maps a tmux client using its socket and reports the active pane agent', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, callback: ExecCallback) => {
        expect(cmd).toBe('/usr/bin/tmux')
        expect(args).toEqual([
          '-S',
          '/tmp/orca.sock',
          'list-clients',
          '-F',
          '#{client_pid}\t#{pane_pid}\t#{pane_current_command}'
        ])
        callback(null, { stdout: '101\t500\tcodex\n', stderr: '' })
      }
    )
    const rows = [
      row(101, 100, 'S+', '/usr/bin/tmux -S /tmp/orca.sock attach-session -t work'),
      row(500, 400, 'Ss', 'zsh'),
      row(501, 500, 'S+', 'node /Users/dev/.nvm/versions/node/bin/codex')
    ]

    await expect(resolveTmuxPaneForegroundProcess(rows, rows[0])).resolves.toBe('codex')
  })

  it('reports the pane shell after its agent exits', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
        callback(null, { stdout: '101\t500\tbash\n', stderr: '' })
      }
    )
    const rows = [row(101, 100, 'S+', 'tmux attach'), row(500, 400, 'Ss+', '/bin/bash')]

    await expect(resolveTmuxPaneForegroundProcess(rows, rows[0])).resolves.toBe('bash')
  })

  it('recognizes session creation and attach commands without matching control commands', () => {
    expect(isTmuxSessionCommand('tmux')).toBe(true)
    expect(isTmuxSessionCommand('tmux new-session -s work')).toBe(true)
    expect(isTmuxSessionCommand('tmux -S /tmp/work.sock attach -t work')).toBe(true)
    expect(isTmuxSessionCommand('tmux list-sessions')).toBe(false)
    expect(isTmuxSessionCommand('tmux kill-server')).toBe(false)
  })
})

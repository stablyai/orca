import { describe, expect, it, vi } from 'vitest'
import { readTmuxPaneBridge } from './tmux-host-attachment-probe'
const run = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: run }))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ isSocket: () => true, uid: process.getuid?.() })
}))
vi.mock('./agent-status/process/agent-process-presence-probe', () => ({
  readAgentProcess: async (pid: number) => ({ verdict: 'live', startTime: `birth-${pid}` })
}))

describe('a tmux pane this terminal does not show', () => {
  const start = process.platform === 'darwin' ? 'Fri Oct  2 03:00:00 2026' : '100'
  // This pane's shell (pts/1), and a client attached in another app's terminal (pts/2).
  const table: Record<number, string> = {
    100: `100 1 100 100 S pts/1 ${start} /bin/bash`,
    300: `300 1 300 301 S pts/2 ${start} -zsh`,
    301: `301 300 301 301 S+ pts/2 ${start} /usr/bin/tmux attach`
  }

  it.each([
    ['refuses it once the other client’s lineage is read', [100, 300, 301], 'elsewhere'],
    ['leaves it unverified when that lineage is unread', [100, 301], null]
  ])('%s', async (_name, readable, expected) => {
    run.mockImplementation(async (options: { program: string; args: string[] }) => {
      const pid = Number(options.args[1])
      const stdout =
        options.program === 'tmux' ? '301:%1' : readable.includes(pid) ? `${table[pid]}\n` : ''
      return { code: 0, timedOut: false, stdout }
    })
    expect(await readTmuxPaneBridge('/tmp/fixture.sock', 100, '%1')).toBe(expected)
  })
})

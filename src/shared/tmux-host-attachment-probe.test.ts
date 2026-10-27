import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeTmuxHostAttachments } from './tmux-host-attachment-probe'
const run = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: run }))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ isSocket: () => true, uid: process.getuid?.() })
}))
vi.mock('./agent-process-presence-probe', () => ({
  readAgentProcess: async (pid: number) => ({ verdict: 'live', startTime: `birth-${pid}` })
}))
let active = 0
let maximum = 0
beforeEach(() => {
  active = 0
  maximum = 0
  run.mockReset()
  run.mockImplementation(async (options: { program: string; args: string[] }) => {
    if (options.program === 'tmux') {
      return {
        code: 0,
        timedOut: false,
        stdout: Array.from({ length: 16 }, (_, i) => `${101 + i}:%${i}`).join('\n')
      }
    }
    const pid = Number(options.args[1])
    active++
    maximum = Math.max(maximum, active)
    await Promise.resolve()
    active--
    const start = process.platform === 'darwin' ? 'Fri Oct  2 03:00:00 2026' : '100'
    return {
      code: 0,
      timedOut: false,
      stdout: `${pid} ${pid === 100 ? 1 : 100} ${pid} ${pid === 100 ? 101 : pid} S pts/1 ${start} ${pid === 100 ? '/bin/bash' : '/usr/bin/tmux attach'}\n`
    }
  })
})
describe('bounded targeted tmux process capture', () => {
  it('captures sixteen clients plus the root in bounded batches without a whole-host scan', async () => {
    const proof = await probeTmuxHostAttachments('/tmp/fixture.sock', [100])
    expect(proof?.clients).toHaveLength(16)
    expect(proof?.rows).toHaveLength(17)
    const calls = run.mock.calls.filter(([options]) => options.program === '/bin/ps')
    expect(calls).toHaveLength(17)
    expect(maximum).toBeLessThanOrEqual(16)
    expect(
      calls.every(([options]) => options.args[0] === '-p' && /^[0-9]+$/.test(options.args[1]))
    ).toBe(true)
  })
})

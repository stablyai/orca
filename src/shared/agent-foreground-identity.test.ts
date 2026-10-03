import { describe, expect, it, vi } from 'vitest'
import { captureAgentForegroundIdentity } from './agent-foreground-identity'
import type { AgentProcessObservation } from './agent-process-presence-probe'

const live = { verdict: 'live', startTime: 'boot:100', zombie: false, foreground: true } as const

describe('execution-host foreground identity', () => {
  it.each(['claude', 'codex', 'gemini', 'cursor', 'pi', 'omp', 'aider'])(
    'captures %s without hook identity',
    async (agent) => {
      const foreground = vi.fn(async () => ({
        available: true,
        processName: agent === 'cursor' ? 'cursor-agent' : agent,
        processId: 4242,
        processStartTime: '100'
      }))
      const read = vi.fn(async () => live)
      expect(await captureAgentForegroundIdentity(foreground, read, 'linux')).toEqual({
        agent,
        process: { pid: 4242, platform: 'linux', startTime: 'boot:100' }
      })
      expect(foreground).toHaveBeenCalledTimes(1)
      expect(read.mock.calls).toEqual([[4242], [4242]])
    }
  )

  it.each([
    { available: false, processName: 'codex', processId: 42 },
    { available: true, processName: 'codex' },
    { available: true, processName: 'zsh', processId: 42 }
  ])('never captures a name-only fallback or shell: %j', async (observation) => {
    const read = vi.fn()
    expect(
      await captureAgentForegroundIdentity(async () => observation, read, 'linux')
    ).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([undefined, '99', '100'])(
    'binds Windows cached identity to its creation marker %s',
    async (start) => {
      const read = vi.fn(async () => ({ ...live, startTime: '100' }))
      const result = await captureAgentForegroundIdentity(
        async () => ({
          available: true,
          processName: 'codex',
          processId: 42,
          processStartTime: start
        }),
        read,
        'win32'
      )
      if (start === '100') {
        expect(result).toMatchObject({ process: { pid: 42, startTime: '100' } })
      } else {
        expect(result).toBeUndefined()
      }
      expect(read).toHaveBeenCalledTimes(start === '100' ? 2 : 1)
    }
  )

  it('matches a Darwin table row and identity read printed on the same UTC, C-locale clock', async () => {
    // Both reads pin TZ=UTC0 and C time names; ps pads a one-digit day with a space.
    const read = vi.fn(async () => ({ ...live, startTime: 'Fri Oct  2 10:50:02 2026' }))
    const observe = (processStartTime: string) =>
      captureAgentForegroundIdentity(
        async () => ({ available: true, processName: 'codex', processId: 42, processStartTime }),
        read,
        'darwin'
      )
    expect(await observe('Fri Oct  2 10:50:02 2026')).toMatchObject({
      process: { pid: 42, startTime: 'Fri Oct  2 10:50:02 2026' }
    })
    // A recycled pid one second apart, and a localized row the pinned table can no longer print.
    expect(await observe('Fri Oct  2 10:50:03 2026')).toBeUndefined()
    expect(await observe('五 10月/ 2 10:50:02 2026')).toBeUndefined()
  })

  it.each([undefined, '99'])(
    'rejects missing or recycled cached start identity %s',
    async (start) => {
      const read = vi.fn(async () => live)
      expect(
        await captureAgentForegroundIdentity(
          async () => ({
            available: true,
            processName: 'codex',
            processId: 42,
            processStartTime: start
          }),
          read,
          'linux'
        )
      ).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(1)
    }
  )

  it.each<AgentProcessObservation>([
    { ...live, startTime: 'boot:101' },
    { ...live, zombie: true },
    { ...live, foreground: false },
    { ...live, stopped: true },
    { verdict: 'exited' },
    { verdict: 'unverifiable' }
  ])('rejects changed or unprovable identity during capture: %j', async (second) => {
    const read = vi
      .fn<() => Promise<AgentProcessObservation>>()
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce(second)
    expect(
      await captureAgentForegroundIdentity(
        async () => ({
          available: true,
          processName: 'codex',
          processId: 4242,
          processStartTime: '100'
        }),
        read,
        'linux'
      )
    ).toBeUndefined()
  })
})

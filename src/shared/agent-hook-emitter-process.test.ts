import { describe, expect, it, vi } from 'vitest'

import { resolveAgentHookEmitterProcess } from './agent-hook-emitter-process'

describe('agent hook emitter process resolution', () => {
  it('walks a hook wrapper to the exact matching provider incarnation', async () => {
    const readProcess = vi.fn(async (pid: number) => {
      if (pid === 301) {
        return { pid, ppid: 200, startTime: 'wrapper-start', command: '/bin/sh hook.sh' }
      }
      if (pid === 200) {
        return { pid, ppid: 100, startTime: 'agent-start', command: '/opt/bin/codex' }
      }
      return null
    })

    await expect(
      resolveAgentHookEmitterProcess('codex', 301, { platform: 'linux', readProcess })
    ).resolves.toEqual({ pid: 200, startTime: 'agent-start' })
  })

  it('rejects a nested foreign provider instead of inheriting its parent identity', async () => {
    const readProcess = vi.fn(async (pid: number) => {
      if (pid === 301) {
        return { pid, ppid: 200, startTime: 'child-start', command: '/opt/bin/claude' }
      }
      return { pid: 200, ppid: 100, startTime: 'root-start', command: '/opt/bin/codex' }
    })

    await expect(
      resolveAgentHookEmitterProcess('codex', 301, { platform: 'linux', readProcess })
    ).resolves.toBeNull()
  })
})

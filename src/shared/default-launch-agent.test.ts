import { describe, expect, it, vi } from 'vitest'
import { resolveDefaultLaunchAgent } from './default-launch-agent'

describe('resolveDefaultLaunchAgent', () => {
  it('uses the configured default when the execution host has it', async () => {
    await expect(
      resolveDefaultLaunchAgent({ defaultTuiAgent: 'omp' }, async () => ['claude', 'omp'])
    ).resolves.toEqual({ agent: 'omp', selection: 'configured' })
  })

  it('names the configured default it skipped when the host lacks it or it is disabled', async () => {
    await expect(
      resolveDefaultLaunchAgent({ defaultTuiAgent: 'omp' }, async () => ['codex', 'claude'])
    ).resolves.toEqual({
      agent: 'claude',
      selection: 'automatic',
      unavailableConfiguredAgent: 'omp'
    })
    await expect(
      resolveDefaultLaunchAgent(
        { defaultTuiAgent: 'omp', disabledTuiAgents: ['omp'] },
        async () => ['omp', 'codex']
      )
    ).resolves.toEqual({
      agent: 'codex',
      selection: 'automatic',
      unavailableConfiguredAgent: 'omp'
    })
  })

  it('refuses a shell-only preference without probing the host', async () => {
    const detect = vi.fn(async () => ['claude'])
    await expect(resolveDefaultLaunchAgent({ defaultTuiAgent: 'blank' }, detect)).resolves.toEqual({
      agent: null,
      reason: 'shell_only'
    })
    expect(detect).not.toHaveBeenCalled()
  })

  it('reports no available agent when nothing enabled is installed', async () => {
    await expect(
      resolveDefaultLaunchAgent(
        { defaultTuiAgent: null, disabledTuiAgents: ['claude'] },
        async () => ['claude', 'not-an-agent']
      )
    ).resolves.toEqual({ agent: null, reason: 'none_available' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type {
  OrcaUninstallPlan,
  OrcaUninstallRunStepArgs
} from '../../../../../../shared/uninstall/orca-uninstall-types'
import { runOrcaUninstallSteps } from './orca-uninstall-plan-state'

const plan: OrcaUninstallPlan = {
  installKind: 'mac-app',
  agents: [{ agent: 'claude', paths: ['~/.claude/settings.json'], state: 'present', detail: null }],
  cliCommand: null,
  backgroundService: { location: 'launchd', state: 'present', detail: null },
  hookScripts: { location: '~/.orca/agent-hooks', state: 'present', detail: null },
  hosts: [],
  otherOrcaBuildName: null,
  appPath: null,
  removeAppCommand: null
}

describe('runOrcaUninstallSteps', () => {
  it('runs only the steps the plan has, and a thrown step marks just its own rows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runStep = vi.fn(async ({ step }: OrcaUninstallRunStepArgs) => {
      if (step === 'background-service') {
        throw new Error('launchctl failed')
      }
      return {
        ...plan,
        agents: [{ ...plan.agents[0], state: 'removed' as const }],
        hookScripts: null
      }
    })

    const result = await runOrcaUninstallSteps(plan, runStep, 'failed', () => {})

    expect(runStep.mock.calls.map(([args]) => args.step)).toEqual([
      'agent-hooks',
      'background-service',
      'hook-scripts'
    ])
    expect(result.agents[0].state).toBe('removed')
    expect(result.backgroundService).toEqual({
      location: 'launchd',
      state: 'error',
      detail: 'failed'
    })
    expect(result.hookScripts?.state).toBe('removed')
  })
})

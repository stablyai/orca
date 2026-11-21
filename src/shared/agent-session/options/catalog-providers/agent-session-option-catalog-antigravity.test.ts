import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../../agent-launch/startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../agent-launch/startup/tui-agent-startup'

// agy refuses a leveled id that conflicts with --effort; its TUI then runs the default model (#39556).
describe('Antigravity model and effort launch arguments', () => {
  it('launches the family with --effort when the requested effort differs from the id level', () => {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'antigravity',
        settings: { agentDefaultArgs: { antigravity: '--dangerously-skip-permissions' } },
        platform: 'darwin',
        isRemote: false,
        shell: 'posix',
        sessionOptions: { model: 'claude-sonnet-5-5-medium', effort: 'low' }
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toBe(
      "agy '--dangerously-skip-permissions' '--model' 'claude-sonnet-5-5' '--effort' 'low'"
    )
  })
})

import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import {
  planLaunchAgentStartupPrompt,
  type LaunchAgentStartupPromptPlan
} from '@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan'
import { stampClaudeLaunchAccount } from '@/lib/claude-launch-account'

type StampArgs = Parameters<typeof stampClaudeLaunchAccount>

export function planNewTabStartup(
  store: StampArgs[0],
  launch: StampArgs[1],
  inputs: Parameters<typeof resolveAgentStartupPlanInputs>[0],
  prompt: Omit<Parameters<typeof planLaunchAgentStartupPrompt>[0], 'base'>
): LaunchAgentStartupPromptPlan {
  const startup = planLaunchAgentStartupPrompt({
    base: resolveAgentStartupPlanInputs(inputs),
    ...prompt
  })
  const { startupPlan } = startup
  return startupPlan
    ? {
        ...startup,
        startupPlan: {
          ...startupPlan,
          launchConfig: stampClaudeLaunchAccount(store, launch, startupPlan.launchConfig)
        }
      }
    : startup
}

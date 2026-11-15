import type { AutomationLaunchSetup } from './automation-launch-types'

export function automationCanonicalLaunchSetup(
  automation: AutomationLaunchSetup & { launchSetup?: AutomationLaunchSetup }
): AutomationLaunchSetup {
  if (automation.launchSetup) {
    return { ...automation.launchSetup }
  }
  return {
    ...(automation.surface !== undefined ? { surface: automation.surface } : {}),
    ...(automation.extraAgentArgs !== undefined
      ? { extraAgentArgs: automation.extraAgentArgs }
      : {}),
    ...(automation.launchPreferences !== undefined
      ? { launchPreferences: automation.launchPreferences }
      : {}),
    ...(automation.agentArgs !== undefined ? { agentArgs: automation.agentArgs } : {})
  }
}

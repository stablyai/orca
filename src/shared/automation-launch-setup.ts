import type { Automation, AutomationLaunchSetupPatch } from './automations-types'
import { AutomationLaunchSetupPatch as PatchSchema } from './rpc-contract/automation-params'

export function applyAutomationLaunchSetupPatch<
  T extends { extraAgentArgs?: string; launchSetupPatch?: AutomationLaunchSetupPatch }
>(input: T): Omit<T, 'launchSetupPatch'> & Pick<Automation, 'surface' | 'extraAgentArgs'> {
  const { launchSetupPatch, ...rest } = input
  if (launchSetupPatch === undefined) {
    return rest
  }
  if (input.extraAgentArgs !== undefined) {
    throw new Error('Save automation arguments through one launch setup change.')
  }
  const patch = PatchSchema.parse(launchSetupPatch)
  return {
    ...rest,
    ...(patch.surface ? { surface: patch.surface } : {}),
    ...(patch.arguments ? { extraAgentArgs: patch.arguments.value } : {})
  }
}

export function automationWithLaunchSetup(automation: Automation): Automation {
  return {
    ...automation,
    launchSetup: {
      ...(automation.surface ? { surface: automation.surface } : {}),
      ...(automation.extraAgentArgs !== undefined
        ? { extraAgentArgs: automation.extraAgentArgs }
        : {})
    }
  }
}

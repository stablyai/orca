import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { AutomationHostTarget } from './automation-host-client'
import {
  getRuntimeAutomationAvailability,
  type AutomationTargetAvailability
} from './automation-target-availability'

export function getAutomationCreateAvailability(args: {
  automationHostTarget: AutomationHostTarget
  runtimeStatusByEnvironmentId?: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
}): AutomationTargetAvailability {
  if (args.automationHostTarget.kind === 'local') {
    return { canRunNow: true, reason: 'available', message: null }
  }
  return getRuntimeAutomationAvailability(
    args.automationHostTarget.environmentId,
    args.runtimeStatusByEnvironmentId
  )
}

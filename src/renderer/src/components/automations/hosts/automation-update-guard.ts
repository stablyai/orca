import type { AutomationEditPrecondition } from '../../../../../shared/automations/automation-edit-precondition'
import type { AutomationAuthorityRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import {
  assertAuthorityCapability,
  AutomationHostScopeUnsupportedError
} from './automation-capability-probe'

export type AutomationUpdateGuard = {
  unchangedSince: AutomationEditPrecondition
  required?: true
}

export async function prepareAutomationUpdateGuard(
  authority: AutomationAuthorityRef,
  guard?: AutomationUpdateGuard
): Promise<AutomationEditPrecondition | undefined> {
  if (!guard) {
    return undefined
  }
  try {
    await assertAuthorityCapability(
      authority,
      AUTOMATION_UPDATE_GUARD_RUNTIME_CAPABILITY,
      'Update Orca on this computer to edit these settings.',
      { cacheConfirmation: false }
    )
    return guard.unchangedSince
  } catch (error) {
    if (!guard.required && error instanceof AutomationHostScopeUnsupportedError) {
      return undefined
    }
    throw error
  }
}

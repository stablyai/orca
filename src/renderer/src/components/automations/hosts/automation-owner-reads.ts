/** Single-record reads through a captured owner, for surfaces that show one automation outside the page's catalog. */

import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { AutomationOwnerRef } from '../../../../../shared/automations/ownership/automation-owner-ref'
import { AutomationHostScopeUnsupportedError } from './automation-capability-probe'
import {
  callAuthority,
  ownerPrecondition,
  readFullAutomationRun
} from './automation-scoped-list-client'

/** One automation through its captured owner: the same `automation.show` the editor rereads with. */
export async function showAutomationForOwner(
  owner: AutomationOwnerRef,
  id: string
): Promise<Automation> {
  const result = await callAuthority<{ automation: Automation }>(
    owner.authority,
    'automation.show',
    {
      id,
      expectedOwner: ownerPrecondition(owner)
    }
  )
  return result.automation
}

/** What one exact run read found; only `definition-missing` means the automation itself is gone. */
export type AutomationRunRead =
  | { kind: 'run'; run: AutomationRun }
  | { kind: 'run-missing' }
  | { kind: 'definition-missing' }
  /** An old host ignored `runId` and listed instead, so this run can't be read from here. */
  | { kind: 'unsupported' }
  | { kind: 'error'; error: unknown }

const RUN_NOT_FOUND_MESSAGE = 'Automation run not found.'

/** One run by id, independent of any recent window, through the captured owner. */
export async function readAutomationRunForOwner(
  owner: AutomationOwnerRef,
  automationId: string,
  runId: string
): Promise<AutomationRunRead> {
  try {
    const run = await readFullAutomationRun(owner.authority, ownerPrecondition(owner), {
      automationId,
      id: runId
    })
    return run ? { kind: 'run', run } : { kind: 'unsupported' }
  } catch (error) {
    if (error instanceof AutomationHostScopeUnsupportedError) {
      return { kind: 'unsupported' }
    }
    if (error instanceof Error && error.message.startsWith(RUN_NOT_FOUND_MESSAGE)) {
      return { kind: 'run-missing' }
    }
    if (error instanceof Error && error.message.startsWith('Automation not found')) {
      return { kind: 'definition-missing' }
    }
    return { kind: 'error', error }
  }
}

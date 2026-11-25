// The receipt's live actions on its own host: each one is bound to the pairing and runtime the
// receipt was captured under, through callReceiptHost.
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { AutomationOwnerPrecondition } from '../../../../shared/automations/ownership/automation-owner-precondition'
import { callReceiptHost, type AutomationReceiptSource } from './automation-receipt-client'

export async function readReceiptRuns(
  source: AutomationReceiptSource,
  id: string,
  owner: AutomationOwnerPrecondition
): Promise<AutomationRun[]> {
  const result = await callReceiptHost<{ runs: AutomationRun[] }>(source, 'automation.runs', {
    automationId: id,
    expectedOwner: owner,
    limit: 3,
    preview: true
  })
  return result.runs.slice(0, 3)
}

export async function updateReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition,
  enabled: boolean
): Promise<Automation> {
  const result = await callReceiptHost<{ automation: Automation }>(source, 'automation.update', {
    id: automation.id,
    expectedOwner: owner,
    updates: { enabled }
  })
  return result.automation
}

export async function deleteReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition
): Promise<boolean> {
  const result = await callReceiptHost<{ removed: boolean; id: string }>(
    source,
    'automation.delete',
    {
      id: automation.id,
      expectedOwner: owner
    }
  )
  return result.removed
}

export async function runReceiptAutomation(
  source: AutomationReceiptSource,
  automation: Automation,
  owner: AutomationOwnerPrecondition
): Promise<void> {
  await callReceiptHost(source, 'automation.runNow', { id: automation.id, expectedOwner: owner })
}

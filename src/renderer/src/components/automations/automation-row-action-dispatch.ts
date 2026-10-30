/** Prefer captured ownership, refuse qualified non-executable rows, and use unfenced fallback only when metadata was never captured, preserving mixed-version clients. */

import type {
  Automation,
  AutomationRun,
  AutomationRunsPage,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import {
  automationActionAvailability,
  capturedAutomationOwner,
  type AutomationCapturedOwner,
  type AutomationRowAction
} from './automation-captured-owner'
import {
  deleteOwnedAutomation,
  listOwnedAutomationRuns,
  listOwnedAutomationRunsPage,
  runOwnedAutomationNow,
  showOwnedAutomation,
  updateOwnedAutomation,
  type AutomationActionResult
} from './automation-owner-action-runner'
import { actionBlockNotice, ownerConflictNotice } from './AutomationOwnerConflictNotice'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'

export type AutomationActionNotice = {
  message: string
  recovery: AutomationHostRecoveryAction | null
  /** Owner refusal forbids degrading to stale data; ordinary failures may still permit it. */
  severity: 'owner' | 'failure'
}

export type AutomationDispatchContext = {
  /** Keyed by `AutomationListRow.key`; see {@link AutomationDispatchRow}. */
  capturedOwners: ReadonlyMap<string, AutomationCapturedOwner>
  authority: AutomationAuthorityRef
}

/** Keep both identities: row key selects the captured host; record ID addresses that authority’s stored copy. */
export type AutomationDispatchRow = {
  rowKey: string
  automationId: string
}

export type AutomationDispatchResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; notice: AutomationActionNotice }

export function dispatched<TValue>(value: TValue): AutomationDispatchResult<TValue> {
  return { ok: true, value }
}

export function toDispatchResult<TValue>(
  outcome: Exclude<AutomationActionResult<TValue>, { status: 'uncaptured' }>
): AutomationDispatchResult<TValue> {
  switch (outcome.status) {
    case 'ok':
      return { ok: true, value: outcome.value }
    case 'blocked':
      return { ok: false, notice: { ...actionBlockNotice(outcome.block), severity: 'owner' } }
    case 'conflict':
      return { ok: false, notice: { ...ownerConflictNotice(outcome.conflict), severity: 'owner' } }
    case 'failed':
      return {
        ok: false,
        notice: { message: outcome.message, recovery: 'retry', severity: 'failure' }
      }
  }
}

async function dispatch<TValue>(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  action: AutomationRowAction,
  fenced: (
    availability: ReturnType<typeof automationActionAvailability>
  ) => Promise<AutomationActionResult<TValue>>,
  legacy: () => Promise<TValue>
): Promise<AutomationDispatchResult<TValue>> {
  const availability = automationActionAvailability(
    capturedAutomationOwner(context.capturedOwners, row.rowKey),
    action
  )
  const outcome = await fenced(availability)
  if (outcome.status !== 'uncaptured') {
    return toDispatchResult(outcome)
  }
  try {
    return { ok: true, value: await legacy() }
  } catch (error) {
    return {
      ok: false,
      notice: {
        message: error instanceof Error ? error.message : String(error),
        recovery: 'retry',
        severity: 'failure'
      }
    }
  }
}

export async function dispatchAutomationUpdate(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  updates: AutomationUpdateInput,
  legacy: () => Promise<Automation>,
  action: AutomationRowAction = 'toggle',
  destination?: AutomationDestination
): Promise<AutomationDispatchResult<Automation>> {
  return await dispatch(
    context,
    row,
    action,
    (availability) =>
      updateOwnedAutomation(
        availability,
        context.authority,
        row.automationId,
        updates,
        destination
      ),
    legacy
  )
}

export async function dispatchAutomationDelete(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  legacy: () => Promise<void>
): Promise<AutomationDispatchResult<void>> {
  return await dispatch(
    context,
    row,
    'delete',
    (availability) => deleteOwnedAutomation(availability, context.authority, row.automationId),
    legacy
  )
}

export async function dispatchAutomationRunNow(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  legacy: () => Promise<AutomationRun>
): Promise<AutomationDispatchResult<AutomationRun>> {
  return await dispatch(
    context,
    row,
    'run',
    (availability) => runOwnedAutomationNow(availability, row.automationId),
    legacy
  )
}

export async function dispatchAutomationReread(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  legacy: () => Promise<Automation | null>
): Promise<AutomationDispatchResult<Automation | null>> {
  return await dispatch(
    context,
    row,
    'edit',
    (availability) => showOwnedAutomation(availability, row.automationId),
    legacy
  )
}

export async function dispatchAutomationRunHistory(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  legacy: () => Promise<AutomationRun[]>,
  authority: AutomationAuthorityRef = context.authority
): Promise<AutomationDispatchResult<AutomationRun[]>> {
  return await dispatch(
    context,
    row,
    'history',
    (availability) => listOwnedAutomationRuns(availability, authority, row.automationId),
    legacy
  )
}

export async function dispatchAutomationRunHistoryPage(
  context: AutomationDispatchContext,
  row: AutomationDispatchRow,
  options: { limit?: number; cursor?: string },
  legacy: () => Promise<AutomationRunsPage>,
  authority: AutomationAuthorityRef = context.authority
): Promise<AutomationDispatchResult<AutomationRunsPage>> {
  return await dispatch(
    context,
    row,
    'history',
    (availability) =>
      listOwnedAutomationRunsPage(availability, authority, row.automationId, options),
    legacy
  )
}

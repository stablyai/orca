/**
 * One place where a row action decides between its fenced path and its legacy
 * one, so the page's handlers stay three lines each.
 *
 * The order is deliberate. A captured owner always wins. A row the authority
 * qualified but could not make executable is refused with the reason. Only a
 * row with no owner metadata at all falls back to the unfenced call, and that
 * arm exists solely so mixed-version clients keep working until the inference
 * is removed — it is the legacy path, not a default.
 */

import type {
  Automation,
  AutomationRun,
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
  /**
   * `owner` means the request was refused because of who owns the record, so
   * the caller must not proceed with a stale copy; `failure` is an ordinary
   * error the caller may still degrade around.
   */
  severity: 'owner' | 'failure'
}

export type AutomationDispatchContext = {
  /** Keyed by `AutomationListRow.key`; see {@link AutomationDispatchRow}. */
  capturedOwners: ReadonlyMap<string, AutomationCapturedOwner>
  authority: AutomationAuthorityRef
}

/**
 * Which copy of a record an action addresses. Both halves are load-bearing and
 * neither derives the other: the row key picks the owner out of a list that may
 * hold the same ID twice, and the ID is what that owner's authority stores it
 * under.
 */
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
  legacy: () => Promise<AutomationRun[]>
): Promise<AutomationDispatchResult<AutomationRun[]>> {
  return await dispatch(
    context,
    row,
    'history',
    (availability) => listOwnedAutomationRuns(availability, context.authority, row.automationId),
    legacy
  )
}

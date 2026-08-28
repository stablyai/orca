/**
 * What a row's captured owner permits.
 *
 * The owner is captured when the row is listed and travels with it; nothing
 * here re-derives ownership from the active runtime, the desktop store, or the
 * record's `runContext`. That is the whole point: an automation the user is
 * looking at may have moved hosts since it was fetched, and the fence only
 * works if the request names the incarnation the user actually saw.
 *
 * Three outcomes, kept distinct because they mean different things to the user:
 * an owned row acts normally; an orphan row still deletes and pauses under the
 * orphan precondition but can never execute; a legacy row proves nothing and
 * stays view-only until its authority advertises fencing.
 */

import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
import type { AutomationOwnerPrecondition } from '../../../../shared/automation-owner-precondition'
import { translate } from '@/i18n/i18n'
import type { AutomationHostRow, AutomationHostRowSelector } from './automation-host-cache-types'
import { ORPHAN_OWNER_PRECONDITION, ownerPrecondition } from './automation-scoped-list-client'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'

/** Every action the page can start against one stored automation. */
export type AutomationRowAction = 'edit' | 'save' | 'toggle' | 'delete' | 'run' | 'history'

export type AutomationActionBlockReason = 'orphan' | 'unfenced'

export type AutomationActionBlock = {
  reason: AutomationActionBlockReason
  message: string
  /** Null when nothing the UI can offer would fix it; the caller then shows no button. */
  recovery: AutomationHostRecoveryAction | null
}

export type AutomationCapturedOwner = {
  owner: AutomationOwnerRef | null
  /** How the authority qualified the row; null when no list metadata was captured at all. */
  selector: AutomationHostRowSelector | null
}

export type AutomationActionAvailability =
  | { kind: 'owned'; owner: AutomationOwnerRef; precondition: AutomationOwnerPrecondition }
  | { kind: 'orphan-fenced'; precondition: AutomationOwnerPrecondition }
  | { kind: 'blocked'; block: AutomationActionBlock }
  /**
   * No owner metadata exists for this row yet, so the caller keeps its legacy
   * unfenced path. Removed with the inference in Step 9, never in the same
   * change — a mixed-version client still depends on it.
   */
  | { kind: 'uncaptured' }

export const UNCAPTURED_AUTOMATION_OWNER: AutomationCapturedOwner = { owner: null, selector: null }

/** Delete and pause survive on an orphan; running it would need a host that no longer exists. */
const ORPHAN_ACTIONS: ReadonlySet<AutomationRowAction> = new Set(['delete', 'toggle', 'history'])

function orphanBlock(): AutomationActionBlock {
  return {
    reason: 'orphan',
    message: translate(
      'auto.components.automations.capturedOwner.orphan',
      'This automation has no host to run on. Delete it, or re-add the host it belongs to.'
    ),
    recovery: null
  }
}

function unfencedBlock(): AutomationActionBlock {
  return {
    reason: 'unfenced',
    message: translate(
      'auto.components.automations.capturedOwner.unfenced',
      'This host cannot confirm which automation it is changing, so this automation is read-only here.'
    ),
    recovery: 'update-server'
  }
}

export function automationActionAvailability(
  captured: AutomationCapturedOwner,
  action: AutomationRowAction
): AutomationActionAvailability {
  if (captured.owner) {
    return {
      kind: 'owned',
      owner: captured.owner,
      precondition: ownerPrecondition(captured.owner)
    }
  }
  if (!captured.selector) {
    return { kind: 'uncaptured' }
  }
  if (captured.selector.kind === 'orphan') {
    return ORPHAN_ACTIONS.has(action)
      ? { kind: 'orphan-fenced', precondition: ORPHAN_OWNER_PRECONDITION }
      : { kind: 'blocked', block: orphanBlock() }
  }
  // A qualified selector with no owner is a legacy row: no generation was ever captured.
  return { kind: 'blocked', block: unfencedBlock() }
}

/** True only for actions the user can start right now; drives the disabled state. */
export function isAutomationActionEnabled(
  captured: AutomationCapturedOwner,
  action: AutomationRowAction
): boolean {
  return automationActionAvailability(captured, action).kind !== 'blocked'
}

/** A committed host row plus the list-row key its actions are looked up by. */
export type AutomationCapturedRow = {
  /** `automationListRowKey`: authority-qualified and incarnation-free. */
  rowKey: string
  row: AutomationHostRow
}

/**
 * The owner map the page keys its actions by. Built from the rows a host query
 * committed, so a row that never loaded simply has no entry and its actions
 * fall back rather than guessing an owner.
 *
 * Keyed by the row key, not the automation ID: an ID is unique only inside one
 * authority, so under All hosts a bare-ID map hands every colliding row the
 * owner of whichever host was listed last. The key stays incarnation-free
 * because it answers "which row is this" — the incarnation lives in the captured
 * `owner` it returns, which is what the request fences on.
 */
export function captureAutomationOwners(
  rows: Iterable<AutomationCapturedRow>
): Map<string, AutomationCapturedOwner> {
  const captured = new Map<string, AutomationCapturedOwner>()
  for (const { rowKey, row } of rows) {
    captured.set(rowKey, { owner: row.owner, selector: row.selector })
  }
  return captured
}

/**
 * Identifies the authority a row was listed under. Distinguishes "listed under
 * this owner" from "listed with no owner at all", so a bare automation ID —
 * unique only inside one authority — is never what a cached result is matched by.
 */
export function capturedAutomationOwnerKey(captured: AutomationCapturedOwner): string {
  if (captured.owner) {
    return ownerKey(captured.owner)
  }
  return captured.selector ? `selector:${captured.selector.kind}` : 'uncaptured'
}

export function capturedAutomationOwner(
  owners: ReadonlyMap<string, AutomationCapturedOwner> | null | undefined,
  rowKey: string | null
): AutomationCapturedOwner {
  return (rowKey === null ? undefined : owners?.get(rowKey)) ?? UNCAPTURED_AUTOMATION_OWNER
}

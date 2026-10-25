/** Carry the listed owner into actions so a host move fences against the incarnation the user saw. Owned rows act normally, orphans allow pause/delete/history but cannot execute, and unfenced legacy rows stay view-only. */

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
  /** No metadata was captured; preserve the unfenced legacy path for mixed-version clients until host ownership can be established. */
  | { kind: 'uncaptured' }

export const UNCAPTURED_AUTOMATION_OWNER: AutomationCapturedOwner = { owner: null, selector: null }

/** Orphans retain pause, delete and history; execution requires a live owning host. */
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
      'Orca on this host needs an update before you can view run history or manage this automation. Scheduled runs may still continue on the host.'
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

/** Capture owners by authority-qualified, incarnation-free row key; IDs collide across hosts. The returned owner supplies the incarnation fence. Unloaded rows have no entry and keep their legacy fallback. */
export function captureAutomationOwners(
  rows: Iterable<AutomationCapturedRow>
): Map<string, AutomationCapturedOwner> {
  const captured = new Map<string, AutomationCapturedOwner>()
  for (const { rowKey, row } of rows) {
    captured.set(rowKey, { owner: row.owner, selector: row.selector })
  }
  return captured
}

/** Match cached results by listed authority, including the distinction between captured ownership and no metadata; bare IDs are authority-local. */
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

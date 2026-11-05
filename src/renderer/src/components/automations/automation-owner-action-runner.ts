/** Run only against supplied captured ownership. Return expected owner conflicts with established recovery verbs rather than generic toasts; never infer from ambient state. */

import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationRunsPage,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import {
  automationOwnerConflictMessage,
  stripAutomationOwnerConflictCode,
  type AutomationOwnerConflictCode
} from '../../../../shared/automation-owner-conflict'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { translate } from '@/i18n/i18n'
import type {
  AutomationActionAvailability,
  AutomationActionBlock
} from './automation-captured-owner'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import {
  AutomationHostScopeUnsupportedError,
  createAutomationForDestination,
  deleteAutomationForOwner,
  deleteOrphanAutomation,
  listAutomationRunsForOwner,
  listAutomationRunsPageForOwner,
  listAutomationsForOwner,
  listScopedAutomations,
  listOrphanAutomationRuns,
  listOrphanAutomationRunsPage,
  matchAutomationOwnerConflict,
  runAutomationNowForOwner,
  updateAutomationForOwner,
  updateOrphanAutomation
} from './automation-scoped-list-client'

export type AutomationOwnerConflict = {
  code: AutomationOwnerConflictCode | 'unsupported_host_scope'
  message: string
  /** Null when no offered action would help — re-adding a removed host is manual. */
  recovery: AutomationHostRecoveryAction | null
}

export type AutomationActionOutcome<TValue> =
  | { status: 'ok'; value: TValue }
  | { status: 'blocked'; block: AutomationActionBlock }
  | { status: 'conflict'; conflict: AutomationOwnerConflict }
  | { status: 'failed'; message: string }

const CONFLICT_RECOVERY: Record<AutomationOwnerConflictCode, AutomationHostRecoveryAction | null> =
  {
    automation_owner_changed: 'retry',
    // The host was deregistered; nothing the page can retry or reconnect brings it back.
    automation_target_removed: null,
    automation_owner_fencing_required: 'update-server',
    automation_destination_invalid: 'retry'
  }

function conflictOutcome(
  code: AutomationOwnerConflictCode,
  error: unknown
): AutomationActionOutcome<never> {
  const message =
    typeof error === 'string'
      ? error
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : null
  return {
    status: 'conflict',
    conflict: {
      code,
      message:
        message && message.trim() !== code
          ? stripAutomationOwnerConflictCode(message)
          : automationOwnerConflictMessage(code),
      recovery: CONFLICT_RECOVERY[code]
    }
  }
}

function classify(error: unknown): AutomationActionOutcome<never> {
  const conflict = matchAutomationOwnerConflict(error)
  if (conflict) {
    return conflictOutcome(conflict, error)
  }
  if (error instanceof AutomationHostScopeUnsupportedError) {
    return {
      status: 'conflict',
      conflict: {
        code: 'unsupported_host_scope',
        message: stripAutomationOwnerConflictCode(error.message),
        recovery: 'update-server'
      }
    }
  }
  return {
    status: 'failed',
    message:
      error instanceof Error
        ? stripAutomationOwnerConflictCode(error.message)
        : translate(
            'auto.components.automations.ownerAction.failed',
            'That automation action did not complete.'
          )
  }
}

/** Block before transport; return uncaptured rows to the caller’s unfenced legacy path instead of guessing an owner. */
async function attempt<TValue>(
  availability: AutomationActionAvailability,
  owned: (owner: AutomationOwnerRef) => Promise<TValue>,
  orphanFenced?: () => Promise<TValue>
): Promise<AutomationActionOutcome<TValue> | { status: 'uncaptured' }> {
  if (availability.kind === 'blocked') {
    return { status: 'blocked', block: availability.block }
  }
  if (availability.kind === 'uncaptured') {
    return { status: 'uncaptured' }
  }
  try {
    if (availability.kind === 'owned') {
      return { status: 'ok', value: await owned(availability.owner) }
    }
    if (!orphanFenced) {
      return { status: 'blocked', block: orphanUnsupported() }
    }
    return { status: 'ok', value: await orphanFenced() }
  } catch (error) {
    return classify(error)
  }
}

function orphanUnsupported(): AutomationActionBlock {
  return {
    reason: 'orphan',
    message: translate(
      'auto.components.automations.capturedOwner.orphan',
      'This automation has no host to run on. Delete it, or re-add the host it belongs to.'
    ),
    recovery: null
  }
}

export type AutomationActionResult<TValue> =
  | AutomationActionOutcome<TValue>
  /** Preserve the caller’s unfenced fallback for rows without captured metadata. */
  | { status: 'uncaptured' }

export async function updateOwnedAutomation(
  availability: AutomationActionAvailability,
  authority: AutomationAuthorityRef,
  id: string,
  updates: AutomationUpdateInput,
  destination?: AutomationDestination
): Promise<AutomationActionResult<Automation>> {
  return await attempt(
    availability,
    (owner) => updateAutomationForOwner(owner, id, updates, destination),
    () => updateOrphanAutomation(authority, id, updates, destination)
  )
}

export async function deleteOwnedAutomation(
  availability: AutomationActionAvailability,
  authority: AutomationAuthorityRef,
  id: string
): Promise<AutomationActionResult<void>> {
  return await attempt(
    availability,
    (owner) => deleteAutomationForOwner(owner, id),
    () => deleteOrphanAutomation(authority, id)
  )
}

export async function runOwnedAutomationNow(
  availability: AutomationActionAvailability,
  id: string
): Promise<AutomationActionResult<AutomationRun>> {
  return await attempt(availability, (owner) => runAutomationNowForOwner(owner, id))
}

/** Re-read edit data within its captured scope so a moved row cannot silently become another authority’s same-ID record. */
export async function showOwnedAutomation(
  availability: AutomationActionAvailability,
  id: string,
  authority?: AutomationAuthorityRef
): Promise<AutomationActionResult<Automation | null>> {
  return await attempt(
    availability,
    async (owner) => {
      const result = await listAutomationsForOwner(owner)
      return result.automations.find((automation) => automation.id === id) ?? null
    },
    authority
      ? async () => {
          const result = await listScopedAutomations(authority, { kind: 'orphan' })
          return result.automations.find((automation) => automation.id === id) ?? null
        }
      : undefined
  )
}

export async function listOwnedAutomationRuns(
  availability: AutomationActionAvailability,
  authority: AutomationAuthorityRef,
  automationId: string
): Promise<AutomationActionResult<AutomationRun[]>> {
  return await attempt(
    availability,
    (owner) => listAutomationRunsForOwner(owner, automationId),
    () => listOrphanAutomationRuns(authority, automationId)
  )
}

export async function listOwnedAutomationRunsPage(
  availability: AutomationActionAvailability,
  authority: AutomationAuthorityRef,
  automationId: string,
  options: { limit?: number; cursor?: string }
): Promise<AutomationActionResult<AutomationRunsPage>> {
  return await attempt(
    availability,
    (owner) => listAutomationRunsPageForOwner(owner, automationId, options),
    () => listOrphanAutomationRunsPage(authority, automationId, options)
  )
}

/** Create is destination-keyed rather than owner-keyed: the row does not exist yet. */
export async function createAutomationAtDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  destination: AutomationDestination
): Promise<AutomationActionOutcome<Automation>> {
  try {
    return {
      status: 'ok',
      value: await createAutomationForDestination(authority, input, destination)
    }
  } catch (error) {
    return classify(error)
  }
}

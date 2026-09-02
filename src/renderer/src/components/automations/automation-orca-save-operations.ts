import { toast } from 'sonner'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type {
  AutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { translate } from '@/i18n/i18n'
import {
  deleteAutomationForTarget,
  listAutomationsForTarget,
  updateAutomationForTarget
} from './automation-host-client'
import { createAutomationAtDestination } from './automation-owner-action-runner'
import {
  dispatchAutomationDelete,
  dispatchAutomationReread,
  dispatchAutomationUpdate,
  toDispatchResult,
  type AutomationActionNotice,
  type AutomationDispatchContext,
  type AutomationDispatchResult
} from './automation-row-action-dispatch'
import {
  revalidateAutomationCreateDestination,
  type AutomationCreateDestination
} from './automation-create-destination'
import type { AutomationHostTarget } from './automation-host-client'
import type { AutomationAuthorityChangeReason } from './automation-host-invalidation'
import type { AutomationSaveContext } from './automation-save-context'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'

export type AutomationMoveOperationContext = {
  automationDispatchContext: AutomationDispatchContext
  editingRowKey: string | null
  automationDialogTarget: AutomationHostTarget
  moveCreationKeysRef: { current: Map<string, string> }
  invalidateWrittenHost: (
    ref: StableAutomationCatalogRef,
    reason: AutomationAuthorityChangeReason
  ) => void
}

export type AutomationEditDestinationInput = {
  currentAutomation: Automation | null
  editingAutomationId: string | null
  editingDestination: {
    projectId: string
    destination: AutomationCreateDestination
  } | null
  draft: Pick<Automation, 'projectId' | 'workspaceId' | 'workspaceMode'> & {
    projectId: string
    workspaceId: string
  }
  rowKey: string | null
  automationDialogTarget: AutomationHostTarget
  editHostEntries: Parameters<typeof revalidateAutomationCreateDestination>[1]
  rowRecoveryHost: (rowKey: string | null) => { stableKey: string } | null
}

export type AutomationEditDestinationResult =
  | {
      ok: true
      editDestination: AutomationDestination | undefined
      moveTarget: AutomationCreateDestination | null
    }
  | { ok: false; notice: AutomationActionNotice }

/** Validates an edited row's destination and identifies a cross-authority move. */
export function resolveAutomationEditDestination(
  input: AutomationEditDestinationInput
): AutomationEditDestinationResult {
  const destinationHostChanged =
    input.editingDestination !== null &&
    input.editingDestination.destination.entry.stableKey !==
      input.rowRecoveryHost(input.rowKey)?.stableKey
  const destinationChanged =
    input.currentAutomation !== null &&
    (destinationHostChanged ||
      input.currentAutomation.projectId !== input.draft.projectId ||
      input.currentAutomation.workspaceId !== (input.draft.workspaceId || null) ||
      input.currentAutomation.workspaceMode !== input.draft.workspaceMode)
  if (!input.editingAutomationId || !input.currentAutomation || !destinationChanged) {
    return { ok: true, editDestination: undefined, moveTarget: null }
  }
  if (!input.editingDestination || input.editingDestination.projectId !== input.draft.projectId) {
    return { ok: false, notice: unavailableDestinationNotice() }
  }
  const revalidated = revalidateAutomationCreateDestination(
    input.editingDestination.destination,
    input.editHostEntries
  )
  if (revalidated.status === 'stale') {
    return {
      ok: false,
      notice: {
        message: translate(
          'auto.components.automations.createDestination.stale',
          '{host} changed while this form was open. Choose the project again before saving.'
        ).replace('{host}', revalidated.entry.label),
        recovery: 'retry',
        severity: 'owner'
      }
    }
  }
  if (revalidated.status !== 'ready') {
    return { ok: false, notice: unavailableDestinationNotice() }
  }
  const sourceAuthorityKey =
    input.automationDialogTarget.kind === 'environment'
      ? automationAuthorityCatalogKey({
          kind: 'runtime',
          environmentId: input.automationDialogTarget.environmentId
        })
      : automationAuthorityCatalogKey({ kind: 'desktop' })
  const targetAuthorityKey = automationAuthorityCatalogKey(
    revalidated.authority.kind === 'runtime'
      ? { kind: 'runtime', environmentId: revalidated.authority.environmentId }
      : { kind: 'desktop' }
  )
  return {
    ok: true,
    editDestination: revalidated.destination,
    moveTarget: sourceAuthorityKey === targetAuthorityKey ? null : revalidated
  }
}

function unavailableDestinationNotice(): AutomationActionNotice {
  return {
    message: translate(
      'auto.components.automations.createDestination.unavailable',
      'Choose an available project on this host before saving.'
    ),
    recovery: 'retry',
    severity: 'owner'
  }
}

/** Creates a new copy first, then removes the source copy when moving hosts. */
export async function moveAutomationToDestination(
  context: AutomationMoveOperationContext,
  source: Automation | null,
  target: AutomationCreateDestination,
  input: AutomationCreateInput
): Promise<{ saved: AutomationDispatchResult<Automation>; originalRemoved: boolean }> {
  if (!source) {
    return {
      saved: {
        ok: false,
        notice: {
          message: translate(
            'auto.components.automations.AutomationsPage.ownerChanged',
            'This automation changed hosts. Refresh and try again.'
          ),
          recovery: 'retry',
          severity: 'owner'
        }
      },
      originalRemoved: false
    }
  }

  const operationKey = `${source.id}:${target.entry.stableKey}`
  const creationKey = context.moveCreationKeysRef.current.get(operationKey) ?? crypto.randomUUID()
  context.moveCreationKeysRef.current.set(operationKey, creationKey)
  const created = toDispatchResult(
    await createAutomationAtDestination(
      target.authority,
      { ...input, creationKey },
      target.destination
    )
  )
  if (!created.ok) {
    return { saved: created, originalRemoved: false }
  }
  context.invalidateWrittenHost(target.entry.stableRef, 'definition')

  const removed = await dispatchAutomationDelete(
    context.automationDispatchContext,
    { rowKey: context.editingRowKey ?? '', automationId: source.id },
    () => deleteAutomationForTarget(source, context.automationDialogTarget)
  )
  if (removed.ok) {
    context.moveCreationKeysRef.current.delete(operationKey)
    return { saved: created, originalRemoved: true }
  }

  // A transport error is not proof that deletion failed; verify the source copy.
  const reread = await dispatchAutomationReread(
    context.automationDispatchContext,
    { rowKey: context.editingRowKey ?? '', automationId: source.id },
    async () =>
      (await listAutomationsForTarget(context.automationDialogTarget)).find(
        (automation) => automation.id === source.id
      ) ?? null
  )
  if (reread.ok && reread.value === null) {
    context.moveCreationKeysRef.current.delete(operationKey)
    return { saved: created, originalRemoved: true }
  }

  const message =
    reread.ok && reread.value
      ? 'Created on {host}, but the original could not be deleted. Remove it on the old host.'
      : 'Created on {host}, but the original deletion could not be verified. Check the old host before retrying.'
  toast.error(
    translate(
      reread.ok && reread.value
        ? 'auto.components.automations.AutomationsPage.moveOriginalKept'
        : 'auto.components.automations.AutomationsPage.moveOriginalUnverified',
      message
    ).replace('{host}', () => target.entry.authorityLabel)
  )
  return { saved: created, originalRemoved: false }
}

/** Writes a new automation through the destination's owner-qualified RPC. */
export async function createAutomationOnDestination(
  authority: AutomationAuthorityRef,
  input: AutomationCreateInput,
  target: AutomationCreateDestination,
  invalidateWrittenHost: AutomationMoveOperationContext['invalidateWrittenHost']
): Promise<AutomationDispatchResult<Automation>> {
  const result = toDispatchResult(
    await createAutomationAtDestination(authority, input, target.destination)
  )
  if (result.ok) {
    invalidateWrittenHost(target.entry.stableRef, 'definition')
  }
  return result
}

export async function saveExistingAutomation(
  context: AutomationSaveContext,
  automationId: string,
  currentAutomation: Automation | null,
  updates: AutomationUpdateInput,
  destination: AutomationDestination | undefined,
  fallbackTarget: AutomationHostTarget | null,
  rowKey: string | null
): Promise<AutomationDispatchResult<Automation>> {
  return await dispatchAutomationUpdate(
    context.destination.automationDispatchContext,
    { rowKey: rowKey ?? '', automationId },
    updates,
    () => {
      if (!currentAutomation) {
        throw new Error(
          translate(
            'auto.components.automations.AutomationsPage.ownerChanged',
            'This automation changed hosts. Refresh and try again.'
          )
        )
      }
      return updateAutomationForTarget(currentAutomation, updates, fallbackTarget)
    },
    'save',
    destination
  )
}

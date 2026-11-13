import type { WorktreeSlice } from '../worktree-slice-contract'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import { cleanupFailedEphemeralVmWorkspace } from '@/runtime/ephemeral-vm/ephemeral-vm-failed-create-cleanup'
import { endWindowCreation } from '@/components/sidebar/sidebar-feed/sidebar-ended-creations'
import { settleVmCreateCheckoutAfterCleanup } from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import { cancelVmEnvironmentCheck } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-decision'
import {
  pendingCreationChatDraftScopeKey,
  type PendingWorktreeCreation
} from '@/lib/workspace/creation/pending-worktree-creation'
import { deleteNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-removal'
import { clearNativeChatPendingAttachments } from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'
import { releaseNativeChatStagedFiles } from '@/components/native-chat/drafts/native-chat-draft-attachment-staging'
import {
  beginOrcaCloudCancelCleanup,
  isOrcaCloudCreateRequest
} from '@/lib/orca-cloud-cancel-cleanup'
import {
  classifyVmBuildFailure,
  isAccountGate
} from '@/components/worktree-creation/vm-build-failure'

/**
 * REFUSED-CREATE-ROW-STICKY: an Orca Cloud create refused before anything started (an account
 * limit such as running sandboxes, a plan, sign-in). Its row keeps the prompt with Retry and
 * Dismiss until the person starts another create, which replaces it. A slot freeing up alone
 * never clears it: that would lose the prompt.
 */
export function isStaleRefusedCreation(entry: PendingWorktreeCreation): boolean {
  return (
    entry.status === 'error' &&
    isOrcaCloudCreateRequest(entry.request) &&
    isAccountGate(classifyVmBuildFailure({ entry, error: entry.error ?? null, cloud: true }))
  )
}

export function createBeginPendingWorktreeCreation(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['beginPendingWorktreeCreation'] {
  return (entry) => {
    // A new create replaces any stale refused row (nothing started there, so nothing to clean up).
    const stale = Object.values(get().pendingWorktreeCreations).filter(
      (other) => other.creationId !== entry.creationId && isStaleRefusedCreation(other)
    )
    const logged = { ...entry, phaseLog: [{ phase: entry.phase, at: entry.startedAt }] }
    set((s) => ({
      pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [entry.creationId]: logged },
      activePendingCreationId: entry.creationId
    }))
    for (const refused of stale) {
      get().removePendingWorktreeCreation(refused.creationId, { cleanupVm: false })
    }
  }
}

// A new startedAt is a fresh attempt (continue/retry); a phase change within one attempt is a new step.
function nextPhaseLog(
  entry: PendingWorktreeCreation,
  patch: Partial<PendingWorktreeCreation>
): PendingWorktreeCreation['phaseLog'] {
  if (patch.startedAt !== undefined && patch.startedAt !== entry.startedAt) {
    return [{ phase: patch.phase ?? entry.phase, at: patch.startedAt }]
  }
  if (patch.phase !== undefined && patch.phase !== entry.phase) {
    return [...(entry.phaseLog ?? []), { phase: patch.phase, at: Date.now() }]
  }
  return entry.phaseLog
}

// When this attempt failed, so a failed step can show how long it ran.
function nextErrorAt(
  entry: PendingWorktreeCreation,
  patch: Partial<PendingWorktreeCreation>
): number | undefined {
  const status = patch.status ?? entry.status
  if (status !== 'error') {
    return undefined
  }
  return entry.status === 'error' ? entry.errorAt : Date.now()
}

export function createUpdatePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['updatePendingWorktreeCreation'] {
  return (creationId, patch) => {
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return s
      }
      const { chatSessionOptions, ...changes } = patch
      if (changes.request || chatSessionOptions) {
        const request = changes.request ?? entry.request
        const ownedOptions =
          request.agent === entry.request.agent
            ? entry.request.launchInputs?.chatSessionOptions
            : undefined
        if (ownedOptions || chatSessionOptions) {
          // Preparation replaces captured requests; the pending composer owns its newer chat picks.
          changes.request = {
            ...request,
            launchInputs: {
              ...request.launchInputs,
              chatSessionOptions: {
                ...(request.launchInputs?.chatSessionOptions ??
                  request.launchInputs?.sessionOptions),
                ...ownedOptions,
                ...chatSessionOptions
              }
            }
          }
        }
      }
      // Why: the main process re-emits the same phase; skip no-op writes so the strip and panel don't re-render.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: changes contains only typed creation fields after chatSessionOptions is removed.
      const hasChange = (Object.keys(changes) as (keyof typeof changes)[]).some(
        (key) => changes[key] !== entry[key]
      )
      if (!hasChange) {
        return s
      }
      return {
        pendingWorktreeCreations: {
          ...s.pendingWorktreeCreations,
          [creationId]: {
            ...entry,
            ...changes,
            phaseLog: nextPhaseLog(entry, changes),
            errorAt: nextErrorAt(entry, changes)
          }
        }
      }
    })
  }
}

export function createRemovePendingWorktreeCreation(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removePendingWorktreeCreation'] {
  return (creationId, options) => {
    let removedEntry: AppState['pendingWorktreeCreations'][string] | undefined
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return s
      }
      removedEntry = entry
      const { [creationId]: _removed, ...rest } = s.pendingWorktreeCreations
      return {
        pendingWorktreeCreations: rest,
        // Why: only clear the active surface if it pointed here, so dismissing a background creation doesn't yank the user away.
        ...(s.activePendingCreationId === creationId ? { activePendingCreationId: null } : {})
      }
    })
    if (removedEntry) {
      // A VM build checking or paused on failed checks stops at once; its create then cleans up the VM.
      cancelVmEnvironmentCheck(creationId)
      endWindowCreation(creationId)
      const scope = pendingCreationChatDraftScopeKey(creationId)
      releaseNativeChatStagedFiles(scope)
      deleteNativeChatComposerDraft(scope)
      clearNativeChatPendingAttachments(scope)
    }
    if (!removedEntry || options?.cleanupVm === false || typeof window === 'undefined') {
      return
    }
    if (removedEntry.phase === 'provisioning-vm' && window.api?.ephemeralVm?.cancelProvision) {
      void window.api.ephemeralVm
        .cancelProvision({ provisionId: creationId })
        .catch(() => undefined)
    }
    const cleanup = cleanUpCancelledVm(creationId, removedEntry.request, get)
    if (removedEntry.status === 'creating' && isOrcaCloudCreateRequest(removedEntry.request)) {
      beginOrcaCloudCancelCleanup(creationId, cleanup ? [cleanup] : [], {
        runtimeId: removedEntry.request.ephemeralVmRuntimeId,
        createStartedAt: removedEntry.startedAt,
        canceledAt: Date.now()
      })
    }
  }
}

/** Resolves false when the VM may still be running; null when the cancel owns no VM yet. */
function cleanUpCancelledVm(
  creationId: string,
  request: PendingWorktreeCreation['request'],
  get: WorktreeSliceGet
): Promise<boolean> | null {
  if (!request.ephemeralVmRuntimeId || !window.api?.ephemeralVm?.cleanup) {
    return null
  }
  return cleanupFailedEphemeralVmWorkspace(request, {
    deleteProjectHostSetup: (setupId, hostId) => get().deleteProjectHostSetup({ setupId, hostId }),
    cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
    reportSetupError: (error) =>
      console.error('Failed to remove cancelled provisioned-root project setup:', error),
    reportRuntimeError: (error) =>
      console.error('Failed to clean up cancelled ephemeral VM runtime:', error)
  }).then((cleanedUp) => {
    settleVmCreateCheckoutAfterCleanup(creationId, cleanedUp)
    return cleanedUp
  })
}

export function createSetActivePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['setActivePendingWorktreeCreation'] {
  return (creationId) => {
    set((s) => {
      if (creationId !== null && !s.pendingWorktreeCreations[creationId]) {
        return s
      }
      return { activePendingCreationId: creationId }
    })
  }
}

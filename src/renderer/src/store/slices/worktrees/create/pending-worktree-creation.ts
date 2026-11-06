import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import { cleanupFailedEphemeralVmWorkspace } from '@/lib/ephemeral-vm-failed-create-cleanup'
import { endWindowCreation } from '@/lib/sidebar-ended-creations'
import {
  pendingCreationChatDraftScopeKey,
  type PendingWorktreeCreation
} from '@/lib/pending-worktree-creation'
import { deleteNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { clearNativeChatPendingAttachments } from '@/components/native-chat/native-chat-pending-attachment-cache'
import { releaseNativeChatStagedFiles } from '@/components/native-chat/native-chat-draft-attachment-staging'

export function createBeginPendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['beginPendingWorktreeCreation'] {
  return (entry) => {
    const logged = { ...entry, phaseLog: [{ phase: entry.phase, at: entry.startedAt }] }
    set((s) => ({
      pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [entry.creationId]: logged },
      activePendingCreationId: entry.creationId
    }))
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
          [creationId]: { ...entry, ...changes, phaseLog: nextPhaseLog(entry, changes) }
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
    if (!removedEntry.request.ephemeralVmRuntimeId || !window.api?.ephemeralVm?.cleanup) {
      return
    }
    void cleanupFailedEphemeralVmWorkspace(removedEntry.request, {
      deleteProjectHostSetup: (setupId, hostId) =>
        get().deleteProjectHostSetup({ setupId, hostId }),
      cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
      reportSetupError: (error) =>
        console.error('Failed to remove cancelled provisioned-root project setup:', error),
      reportRuntimeError: (error) =>
        console.error('Failed to clean up cancelled ephemeral VM runtime:', error)
    })
  }
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

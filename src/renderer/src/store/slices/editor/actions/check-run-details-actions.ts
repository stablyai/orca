import { loadActionsDetailTab } from '@/store/github/actions-detail-tabs'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { translate } from '@/i18n/i18n'
import {
  buildCheckRunDetailsTabId,
  createCheckRunDetailsRequestId,
  getCheckRunDetailsTabLabel,
  type CheckRunDetailsTabPatch
} from '@/components/editor/check-run-details-tab'
import type { OpenCheckRunDetailsState } from '../../../../../../shared/editor-tab-view-types'
import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import type { OpenFile } from '../types/open-file'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'
import { reconcileCheckDetailsReadingCache } from '@/components/editor/check-details-reading-cache'
import {
  findCheckRequestTabId,
  findCheckRunDetailsOwner,
  getCheckRunDetailsOwnerScope,
  isSameCheckRunDetailsOwner,
  resolveCheckRunDetailsOwnership
} from './check-run-details-owner'
import { createCheckRunDetailsTabPatcher } from './check-run-details-patch'

/** Keep Actions detail tabs on their owner-bound loader while retaining existing GitHub and GitLab check paths. */
export function createCheckRunDetailsActions(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  'openCheckRunDetails' | 'patchOpenCheckRunDetails' | 'reloadOpenCheckRunDetailsTab'
> {
  // Restored numeric request IDs belong to a previous renderer lifetime.
  const requests = new WeakSet<OpenCheckRunDetailsState>()
  const patchCheckRunDetailsTab = createCheckRunDetailsTabPatcher(set, get, requests)

  return {
    /** Open or focus the stable detail tab while retaining its Actions owner context and current snapshot. */
    openCheckRunDetails: (worktreeId, contextKey, check, state) => {
      const resolvedOwnership = resolveCheckRunDetailsOwnership(get(), worktreeId)
      const id = buildCheckRunDetailsTabId(
        worktreeId,
        check,
        getCheckRunDetailsOwnerScope(resolvedOwnership)
      )
      const label = getCheckRunDetailsTabLabel(check)
      const checkRunDetails: OpenCheckRunDetailsState = {
        actionsAttempt: state.actionsAttempt,
        actionsContext: state.actionsContext,
        contextKey,
        check,
        requestId: state.requestId,
        details: state.details,
        loading: state.loading,
        error: state.error,
        githubRepository: state.githubRepository ?? null,
        gitlabProjectRef: state.gitlabProjectRef ?? null
      }
      let accepted:
        | {
            previous: OpenCheckRunDetailsState | undefined
            next: OpenCheckRunDetailsState
          }
        | undefined
      set((s) => {
        const existing = s.openFiles.find((f) => f.id === id)
        // Why: an open whose owner cannot be resolved must not leave the tab reloading through its old owner.
        const ownership =
          existing && isSameCheckRunDetailsOwner(existing, resolvedOwnership)
            ? {}
            : (resolvedOwnership ?? {
                runtimeEnvironmentId: undefined,
                operationProvenance: undefined
              })
        if (existing) {
          const existingDetails = existing.checkRunDetails
          const incomingIsStale =
            existing.mode === 'check-details' &&
            existingDetails?.contextKey === contextKey &&
            existingDetails.requestId !== undefined &&
            (state.requestId === undefined || state.requestId < existingDetails.requestId)
          if (!incomingIsStale) {
            accepted = {
              previous: existing.mode === 'check-details' ? existingDetails : undefined,
              next: checkRunDetails
            }
          }
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    ...ownership,
                    mode: 'check-details' as const,
                    relativePath: label,
                    language: 'plaintext',
                    checkRunDetails: incomingIsStale ? existingDetails : checkRunDetails
                  }
                : f
            ),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: {
              ...s.activeFileIdByWorktree,
              [worktreeId]: id
            },
            activeTabTypeByWorktree: {
              ...s.activeTabTypeByWorktree,
              [worktreeId]: 'editor'
            }
          }
        }

        accepted = { previous: undefined, next: checkRunDetails }
        const newFile: OpenFile = {
          id,
          filePath: id,
          relativePath: label,
          worktreeId,
          ...ownership,
          language: 'plaintext',
          isDirty: false,
          mode: 'check-details',
          checkRunDetails
        }

        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: {
            ...s.activeFileIdByWorktree,
            [worktreeId]: id
          },
          activeTabTypeByWorktree: {
            ...s.activeTabTypeByWorktree,
            [worktreeId]: 'editor'
          }
        }
      })
      if (accepted) {
        const { previous, next } = accepted
        requests.add(next)
        reconcileCheckDetailsReadingCache(id, previous, next, () => {
          const live = get().openFiles.find((file) => file.id === id)
          return live?.mode === 'check-details' && live.checkRunDetails === next
        })
      }
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'check-details')
    },

    // Why: sidebar detail fetches can finish after the full-details tab is open; update the snapshot without stealing focus.
    /** Update an existing matching tab without stealing focus or overwriting a newer request generation. */
    patchOpenCheckRunDetails: (worktreeId, contextKey, check, state) => {
      const live = get()
      // Why: a request's completion belongs to the tab it started on, even after the user selects a twin host.
      const id =
        findCheckRequestTabId(live.openFiles, worktreeId, check, state.requestId, requests) ??
        buildCheckRunDetailsTabId(
          worktreeId,
          check,
          getCheckRunDetailsOwnerScope(resolveCheckRunDetailsOwnership(live, worktreeId))
        )
      patchCheckRunDetailsTab(id, contextKey, check, state)
    },

    /** Use the owner-bound Actions loader when present; otherwise retain the provider-specific check reload path. */
    reloadOpenCheckRunDetailsTab: async (fileId) => {
      const state = get()
      const file = state.openFiles.find((candidate) => candidate.id === fileId)
      const checkRunDetails = file?.checkRunDetails
      if (!file || file.mode !== 'check-details' || !checkRunDetails) {
        return
      }
      if (checkRunDetails.actionsContext) {
        await loadActionsDetailTab(get, fileId)
        return
      }
      const { contextKey, check } = checkRunDetails
      const requestId = createCheckRunDetailsRequestId()
      /** Apply detail results with this request ID so a slower generation cannot overwrite a newer tab state. */
      const patch = (next: CheckRunDetailsTabPatch): void => {
        const current = get().openFiles.find(
          (candidate) => candidate.id === fileId
        )?.checkRunDetails
        const details =
          next.details ?? (current?.contextKey === contextKey ? current.details : null)
        // Why: the active host can differ from the tab's owner, so patch this tab rather than re-deriving its id.
        patchCheckRunDetailsTab(fileId, contextKey, check, {
          ...next,
          details,
          requestId
        })
      }
      const owner = findCheckRunDetailsOwner(state, file)
      const worktree = owner?.worktree
      const repo = owner?.repo
      if (!repo?.path) {
        patch({
          details: checkRunDetails.details,
          loading: false,
          error: translate(
            'auto.store.slices.editor.checkRunDetailsRepoUnavailable',
            'Repository details are unavailable for this check.'
          )
        })
        return
      }
      if (checkRunDetails.loading) {
        return
      }
      patch({ details: checkRunDetails.details, loading: true, error: null })
      try {
        const repoOwnerExecutionHostId = forgeOwnerHostIdForWorkspace(repo, worktree)
        // GitLab jobs require GitLab trace; GitHub check-runs returns null and blanks the refreshed tab.
        const details = check.gitlabJobId
          ? await loadGitLabJobLogDetails({
              repoPath: repo.path,
              repoId: repo.id,
              repoOwnerExecutionHostId,
              check,
              // Why: a fork MR's job lives in the source project, not the repo's own.
              projectRef: checkRunDetails.gitlabProjectRef ?? null
            })
          : await get().fetchPRCheckDetails(
              repo.path,
              {
                checkRunId: check.checkRunId,
                workflowRunId: check.workflowRunId,
                checkName: check.name,
                url: check.url,
                prRepo: checkRunDetails.githubRepository ?? null
              },
              { repoId: repo.id, repoOwnerExecutionHostId }
            )
        patch({
          details,
          loading: false,
          error: details
            ? null
            : translate(
                'auto.store.slices.editor.checkRunDetailsUnavailable',
                'No details are available for this check.'
              )
        })
      } catch {
        patch({
          details: null,
          loading: false,
          error: translate(
            'auto.store.slices.editor.checkRunDetailsLoadFailed',
            'Failed to load check details.'
          )
        })
      }
    }
  }
}

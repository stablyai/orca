import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { translate } from '@/i18n/i18n'
import {
  buildCheckRunDetailsTabId,
  createCheckRunDetailsRequestId,
  getCheckRunDetailsTabLabel,
  isSameGitHubRepository,
  isSameGitLabProjectRef,
  type CheckRunDetailsTabPatch,
  type OpenCheckRunDetailsState
} from '@/components/editor/check-run-details-tab'
import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { findWorktreeById, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import type { OpenFile } from '../types/open-file'
import { openWorkspaceEditorItem } from '../tabs/workspace-editor-item'

export function createCheckRunDetailsActions(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  'openCheckRunDetails' | 'patchOpenCheckRunDetails' | 'reloadOpenCheckRunDetailsTab'
> {
  return {
    openCheckRunDetails: (worktreeId, contextKey, check, state) => {
      const id = buildCheckRunDetailsTabId(worktreeId, check)
      const label = getCheckRunDetailsTabLabel(check)
      const checkRunDetails: OpenCheckRunDetailsState = {
        contextKey,
        check,
        requestId: state.requestId,
        details: state.details,
        loading: state.loading,
        error: state.error,
        githubRepository: state.githubRepository ?? null,
        gitlabProjectRef: state.gitlabProjectRef ?? null
      }
      set((s) => {
        const existing = s.openFiles.find((f) => f.id === id)
        if (existing) {
          const existingDetails = existing.checkRunDetails
          const incomingIsStale =
            existingDetails?.contextKey === contextKey &&
            existingDetails.requestId !== undefined &&
            (state.requestId === undefined || state.requestId < existingDetails.requestId)
          return {
            openFiles: s.openFiles.map((f) =>
              f.id === id
                ? {
                    ...f,
                    mode: 'check-details' as const,
                    relativePath: label,
                    language: 'plaintext',
                    checkRunDetails: incomingIsStale ? existingDetails : checkRunDetails
                  }
                : f
            ),
            activeFileId: id,
            activeTabType: 'editor',
            activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
            activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
          }
        }

        const newFile: OpenFile = {
          id,
          filePath: id,
          relativePath: label,
          worktreeId,
          language: 'plaintext',
          isDirty: false,
          mode: 'check-details',
          checkRunDetails
        }

        return {
          openFiles: [...s.openFiles, newFile],
          activeFileId: id,
          activeTabType: 'editor',
          activeFileIdByWorktree: { ...s.activeFileIdByWorktree, [worktreeId]: id },
          activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: 'editor' }
        }
      })
      void openWorkspaceEditorItem(get(), id, worktreeId, label, 'check-details')
    },

    // Why: sidebar detail fetches can finish after the full-details tab is open; update the snapshot without stealing focus.
    patchOpenCheckRunDetails: (worktreeId, contextKey, check, state) => {
      const id = buildCheckRunDetailsTabId(worktreeId, check)
      set((s) => {
        const existing = s.openFiles.find((f) => f.id === id)
        if (!existing?.checkRunDetails) {
          return s
        }
        const current = existing.checkRunDetails
        if (current.contextKey !== contextKey) {
          return s
        }
        if (
          state.requestId !== undefined &&
          current.requestId !== undefined &&
          state.requestId < current.requestId
        ) {
          return s
        }
        // Why: the sidebar resolves the MR's project asynchronously, so an early patch
        // must not blank a ref we already know.
        const githubRepository = state.githubRepository ?? current.githubRepository ?? null
        const gitlabProjectRef = state.gitlabProjectRef ?? current.gitlabProjectRef ?? null
        const nextCheckRunDetails: OpenCheckRunDetailsState = {
          contextKey,
          check,
          requestId: state.requestId ?? current.requestId,
          details: state.details,
          loading: state.loading,
          error: state.error,
          githubRepository,
          gitlabProjectRef
        }
        if (
          current.contextKey === nextCheckRunDetails.contextKey &&
          current.requestId === nextCheckRunDetails.requestId &&
          current.check.status === nextCheckRunDetails.check.status &&
          current.check.conclusion === nextCheckRunDetails.check.conclusion &&
          current.loading === nextCheckRunDetails.loading &&
          current.error === nextCheckRunDetails.error &&
          current.details === nextCheckRunDetails.details &&
          isSameGitHubRepository(current.githubRepository ?? null, githubRepository) &&
          isSameGitLabProjectRef(current.gitlabProjectRef ?? null, gitlabProjectRef)
        ) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === id ? { ...f, checkRunDetails: nextCheckRunDetails } : f
          )
        }
      })
    },

    reloadOpenCheckRunDetailsTab: async (fileId) => {
      const state = get()
      const file = state.openFiles.find((candidate) => candidate.id === fileId)
      const checkRunDetails = file?.checkRunDetails
      if (!file || file.mode !== 'check-details' || !checkRunDetails) {
        return
      }
      const { contextKey, check } = checkRunDetails
      const requestId = createCheckRunDetailsRequestId()
      const patch = (next: CheckRunDetailsTabPatch): void => {
        get().patchOpenCheckRunDetails(file.worktreeId, contextKey, check, { ...next, requestId })
      }
      const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
      const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(file.worktreeId)
      const repo = state.repos.find((candidate) => candidate.id === repoId)
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
      patch({ details: checkRunDetails.details, loading: true, error: null })
      try {
        // Why: refreshing a GitLab job tab through the GitHub check-runs API returns
        // null and would blank the tab the user just asked to reload.
        const details = check.gitlabJobId
          ? await loadGitLabJobLogDetails({
              repoPath: repo.path,
              repoId: repo.id,
              settings: getSettingsForWorktreeRuntimeOwner(state, file.worktreeId),
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
              { repoId: repo.id }
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
      } catch (error) {
        patch({
          details: null,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.store.slices.editor.checkRunDetailsLoadFailed',
                  'Failed to load check details.'
                )
        })
      }
    }
  }
}

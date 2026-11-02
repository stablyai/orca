import { worktreeMatchesGitHubNumber } from '@/lib/github-work-item-workspace-attachment'
import { getPaletteWorktreeExecutionHostId } from '@/lib/palette-repo-resolution'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { lookupGitHubWorkItemForSource } from '@/lib/github-work-item-source-lookup'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { getRepoMapFromState } from '@/store/selectors'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'
import { buildLinearIssueComposerData } from '@/lib/linear-linked-work-item'
import { isWorktreePaletteCreateActivationAllowed } from '@/lib/worktree-palette-create-action'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteSelectionLifecycle } from './use-worktree-jump-palette-selection-lifecycle'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteTaskUrl } from './use-worktree-jump-palette-task-url'

type WorktreeJumpPaletteCreateWorktreeInput = Pick<
  WorktreeJumpPaletteStoreState,
  'workspaces' | 'closeModal' | 'openModal' | 'recordFeatureInteraction'
> &
  Pick<WorktreeJumpPaletteFilter, 'repoMap'> &
  Pick<
    WorktreeJumpPaletteLocalState,
    | 'createLookupGuard'
    | 'createWorktreeName'
    | 'liveQueryRef'
    | 'preserveCreateLookupOnCloseRef'
    | 'selectionMovedByUserRef'
    | 'skipRestoreFocusRef'
    | 'taskSourceUrl'
  > &
  Pick<WorktreeJumpPaletteQuickActions, 'prefetchCreateWorkspaceBaseForComposer'> &
  Pick<WorktreeJumpPaletteSelectionLifecycle, 'focusFallbackSurface'> &
  Pick<
    WorktreeJumpPaletteTaskUrl,
    | 'currentGitHubWorkItemPreview'
    | 'githubLookupRef'
    | 'linearIssueUrlIntent'
    | 'linearLookupRef'
    | 'taskUrlCreatePreview'
  >

export function createWorktreeJumpPaletteWorktreeHandler({
  workspaces,
  closeModal,
  createLookupGuard,
  createWorktreeName,
  currentGitHubWorkItemPreview,
  focusFallbackSurface,
  githubLookupRef,
  liveQueryRef,
  linearIssueUrlIntent,
  linearLookupRef,
  openModal,
  prefetchCreateWorkspaceBaseForComposer,
  preserveCreateLookupOnCloseRef,
  recordFeatureInteraction,
  repoMap,
  selectionMovedByUserRef,
  skipRestoreFocusRef,
  taskSourceUrl,
  taskUrlCreatePreview
}: WorktreeJumpPaletteCreateWorktreeInput): () => void {
  return () => {
    const trimmed = createWorktreeName.trim()
    if (liveQueryRef.current.trim() !== trimmed) {
      return
    }
    if (
      !isWorktreePaletteCreateActivationAllowed({
        hasTaskUrlIntent: taskSourceUrl !== null,
        hasCreateName: trimmed.length > 0,
        selectionMovedByUser: selectionMovedByUserRef.current
      })
    ) {
      return
    }
    const ghLink = parseGitHubIssueOrPRLink(trimmed)
    const ghNumber = parseGitHubIssueOrPRNumber(trimmed)
    const openComposer = (data: Record<string, unknown>): void => {
      skipRestoreFocusRef.current = true
      prefetchCreateWorkspaceBaseForComposer(
        typeof data.initialRepoId === 'string' ? data.initialRepoId : undefined
      )
      closeModal()
      recordFeatureInteraction('cmd-j-create-workspace')
      queueMicrotask(() =>
        openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
      )
    }

    if (linearIssueUrlIntent) {
      const lookup = linearLookupRef.current
      if (!lookup || lookup.query !== trimmed) {
        return
      }
      const lease = lookup.lease
      let unsubscribe = () => {}
      const schedule = () => {
        const view = lease.currentView()
        if (view.kind === 'abandoned') {
          unsubscribe()
          return
        }
        if (view.kind === 'loading') {
          return
        }
        queueMicrotask(() => {
          lease.commit(view, false, (_, preview) => {
            if (
              !preview ||
              linearLookupRef.current !== lookup ||
              liveQueryRef.current.trim() !== trimmed ||
              useAppStore.getState().activeModal !== 'worktree-palette'
            ) {
              return false
            }
            const data = preview.issue
              ? {
                  ...buildLinearIssueComposerData(preview.issue, preview.sourceContext),
                  ...(preview.initialRepoId ? { initialRepoId: preview.initialRepoId } : {})
                }
              : preview.initialRepoId
                ? { prefilledName: trimmed, initialRepoId: preview.initialRepoId }
                : { prefilledName: trimmed }
            unsubscribe()
            skipRestoreFocusRef.current = true
            prefetchCreateWorkspaceBaseForComposer(
              typeof data.initialRepoId === 'string' ? data.initialRepoId : undefined
            )
            closeModal()
            recordFeatureInteraction('cmd-j-create-workspace')
            openModal('new-workspace-composer', { ...data, telemetrySource: 'command_palette' })
            return true
          })
        })
      }
      unsubscribe = lease.subscribe(schedule)
      schedule()
      return
    }

    if (ghLink) {
      const lookup = githubLookupRef.current
      const resolve = async (): Promise<void> => {
        const preview = currentGitHubWorkItemPreview?.loading
          ? await lookup?.promise
          : (currentGitHubWorkItemPreview ?? (await lookup?.promise))
        if (
          !preview ||
          lookup?.query !== trimmed ||
          githubLookupRef.current !== lookup ||
          liveQueryRef.current.trim() !== trimmed ||
          useAppStore.getState().activeModal !== 'worktree-palette'
        ) {
          return
        }
        const item = preview.item
        if (item) {
          const linkedWorkItem: LinkedWorkItemSummary = {
            provider: 'github',
            type: item.type,
            number: item.number,
            title: item.title,
            url: item.url,
            ...(item.repoId ? { repoId: item.repoId } : {})
          }
          openComposer({
            prefilledName:
              getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
              getLinkedWorkItemSuggestedName({ title: item.title }),
            linkedWorkItem,
            initialGitHubWorkItem: item,
            ...(preview.initialRepoId ? { initialRepoId: preview.initialRepoId } : {}),
            ...(preview.sourceContext ? { taskSourceContext: preview.sourceContext } : {})
          })
        } else {
          openComposer({
            prefilledName: trimmed,
            ...(preview.initialRepoId ? { initialRepoId: preview.initialRepoId } : {})
          })
        }
      }
      void resolve()
      return
    }

    if (taskUrlCreatePreview) {
      const state = useAppStore.getState()
      const eligibleRepos = state.repos.filter((repo) => isGitRepoKind(repo))
      const repo =
        (state.activeRepoId &&
          eligibleRepos.find((candidate) => candidate.id === state.activeRepoId)) ||
        eligibleRepos[0]
      openComposer(
        repo ? { prefilledName: trimmed, initialRepoId: repo.id } : { prefilledName: trimmed }
      )
      return
    }

    if (ghNumber !== null) {
      const state = useAppStore.getState()
      const matches = workspaces.filter(
        (worktree) =>
          !worktree.isArchived &&
          worktreeMatchesGitHubNumber(
            worktree,
            ghNumber,
            findRepoForHost(state.repos, worktree.repoId, {
              hostId: getPaletteWorktreeExecutionHostId(worktree),
              settings: state.settings
            }) ?? undefined
          )
      )
      const activeMatch =
        matches.find((worktree) => worktree.repoId === state.activeRepoId) ?? matches[0]
      if (activeMatch) {
        const executionHostId = getPaletteWorktreeExecutionHostId(activeMatch)
        const activation = activateAndRevealWorkspace(
          activeMatch.id,
          executionHostId ? { executionHostId } : {}
        )
        if (!activation) {
          return
        }
        skipRestoreFocusRef.current = true
        closeModal()
        if (!queueWorkspaceActivationTerminalFocus(activeMatch.id, activation)) {
          focusFallbackSurface()
        }
        recordFeatureInteraction('cmd-j-workspace-open')
        return
      }
      const repo =
        (state.activeRepoId ? (repoMap.get(state.activeRepoId) ?? null) : null) ||
        [...getRepoMapFromState(state).values()].find((candidate) => isGitRepoKind(candidate))
      if (!repo || !isGitRepoKind(repo)) {
        openComposer({ prefilledName: trimmed })
        return
      }
      prefetchCreateWorkspaceBaseForComposer(repo.id)
      const sourceContext = buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: repo.id,
        repo
      })
      const token = createLookupGuard.start()
      preserveCreateLookupOnCloseRef.current = true
      skipRestoreFocusRef.current = true
      recordFeatureInteraction('cmd-j-create-workspace')
      closeModal()
      void lookupGitHubWorkItemForSource({
        repoPath: repo.path,
        repoId: repo.id,
        sourceContext,
        number: ghNumber
      })
        .then((item) => {
          if (!createLookupGuard.isCurrent(token)) {
            return
          }
          const linkedWorkItem = item
            ? { type: item.type, number: item.number, title: item.title, url: item.url }
            : null
          queueMicrotask(() =>
            openModal('new-workspace-composer', {
              initialRepoId: repo.id,
              ...(linkedWorkItem
                ? {
                    linkedWorkItem,
                    prefilledName:
                      getLinkedWorkItemWorkspaceName(linkedWorkItem)?.seedName ??
                      getLinkedWorkItemSuggestedName({ title: linkedWorkItem.title })
                  }
                : { prefilledName: trimmed }),
              telemetrySource: 'command_palette'
            })
          )
        })
        .catch(() => {
          if (createLookupGuard.isCurrent(token)) {
            queueMicrotask(() =>
              openModal('new-workspace-composer', {
                initialRepoId: repo.id,
                prefilledName: trimmed,
                telemetrySource: 'command_palette'
              })
            )
          }
        })
      return
    }
    openComposer(trimmed ? { prefilledName: trimmed } : {})
  }
}

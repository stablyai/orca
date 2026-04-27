/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Worktree, WorkspaceVisibleTabType, WorktreeMeta } from '../../../../shared/types'
import {
  findWorktreeById,
  applyWorktreeUpdates,
  getRepoIdFromWorktreeId,
  type WorktreeSlice
} from './worktree-helpers'
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers'

function areWorktreesEqual(current: Worktree[] | undefined, next: Worktree[]): boolean {
  if (!current || current.length !== next.length) {
    return false
  }

  return current.every((worktree, index) => {
    const candidate = next[index]
    return (
      worktree.id === candidate.id &&
      worktree.repoId === candidate.repoId &&
      worktree.path === candidate.path &&
      worktree.head === candidate.head &&
      worktree.branch === candidate.branch &&
      worktree.isBare === candidate.isBare &&
      worktree.isMainWorktree === candidate.isMainWorktree &&
      worktree.displayName === candidate.displayName &&
      worktree.comment === candidate.comment &&
      worktree.linkedIssue === candidate.linkedIssue &&
      worktree.linkedPR === candidate.linkedPR &&
      worktree.isArchived === candidate.isArchived &&
      worktree.isUnread === candidate.isUnread &&
      worktree.isPinned === candidate.isPinned &&
      worktree.sortOrder === candidate.sortOrder &&
      worktree.lastActivityAt === candidate.lastActivityAt
    )
  })
}

function toVisibleTabType(contentType: string): WorkspaceVisibleTabType {
  return contentType === 'browser' ? 'browser' : contentType === 'terminal' ? 'terminal' : 'editor'
}

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  activeWorktreeId: null,
  deleteStateByWorktreeId: {},
  sortEpoch: 0,

  fetchWorktrees: async (repoId) => {
    try {
      const worktrees = await window.api.worktrees.list({ repoId })
      const current = get().worktreesByRepo[repoId]
      if (areWorktreesEqual(current, worktrees)) {
        return
      }

      // Why: `git worktree list` can fail transiently (e.g. concurrent git
      // operations holding a lock, disk I/O hiccup). The backend catches these
      // errors and returns []. Replacing a known-good worktree list with []
      // causes tabsByWorktree entries to become orphaned — the agent activity
      // badge then shows raw worktree IDs instead of display names, and click-
      // to-navigate silently fails because findWorktreeById returns undefined.
      // Keep the stale-but-correct data until the next successful refresh.
      if (worktrees.length === 0 && current && current.length > 0) {
        return
      }

      set((s) => ({
        // Why: active worktrees can change branches entirely from a terminal.
        // We refresh that live git identity into renderer state, but only bump
        // sortEpoch when git actually reports a different worktree payload.
        worktreesByRepo: { ...s.worktreesByRepo, [repoId]: worktrees },
        sortEpoch: s.sortEpoch + 1
      }))
    } catch (err) {
      console.error(`Failed to fetch worktrees for repo ${repoId}:`, err)
    }
  },

  fetchAllWorktrees: async () => {
    const { repos } = get()
    await Promise.all(repos.map((r) => get().fetchWorktrees(r.id)))
  },

  createWorktree: async (repoId, name, baseBranch, setupDecision = 'inherit') => {
    const retryableConflictPatterns = [
      /already exists locally/i,
      /already exists on a remote/i,
      /already has pr #\d+/i
    ]
    const nextCandidateName = (current: string, attempt: number): string =>
      attempt === 0 ? current : `${current}-${attempt + 1}`

    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidateName = nextCandidateName(name, attempt)
        try {
          const result = await window.api.worktrees.create({
            repoId,
            name: candidateName,
            baseBranch,
            setupDecision
          })
          set((s) => ({
            worktreesByRepo: {
              ...s.worktreesByRepo,
              [repoId]: [...(s.worktreesByRepo[repoId] ?? []), result.worktree]
            },
            sortEpoch: s.sortEpoch + 1
          }))
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const shouldRetry = retryableConflictPatterns.some((pattern) => pattern.test(message))
          if (!shouldRetry || attempt === 24) {
            throw error
          }
        }
      }

      throw new Error('Failed to create worktree after retrying branch conflicts.')
    } catch (err) {
      console.error('Failed to create worktree:', err)
      throw err
    }
  },

  removeWorktree: async (worktreeId, force) => {
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [worktreeId]: {
          isDeleting: true,
          error: null,
          canForceDelete: false
        }
      }
    }))

    try {
      // Why: setup-enabled worktrees now commonly have a live shell open as soon as
      // they are created. We must tear those PTYs down before asking Git to remove
      // the working tree or Windows and some shells can keep the directory in use
      // and make delete look broken even though the git state itself is fine.
      await get().shutdownWorktreeTerminals(worktreeId)
      await window.api.worktrees.remove({ worktreeId, force })
      const tabs = get().tabsByWorktree[worktreeId] ?? []
      const tabIds = new Set(tabs.map((t) => t.id))

      set((s) => {
        const next = { ...s.worktreesByRepo }
        for (const repoId of Object.keys(next)) {
          next[repoId] = next[repoId].filter((w) => w.id !== worktreeId)
        }
        const nextTabs = { ...s.tabsByWorktree }
        delete nextTabs[worktreeId]
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        for (const tabId of tabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
        }
        const nextDeleteState = { ...s.deleteStateByWorktreeId }
        delete nextDeleteState[worktreeId]
        // Clean up editor files belonging to this worktree
        const newOpenFiles = s.openFiles.filter((f) => f.worktreeId !== worktreeId)
        const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
        delete nextBrowserTabsByWorktree[worktreeId]
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        delete nextActiveFileIdByWorktree[worktreeId]
        const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
        delete nextActiveBrowserTabIdByWorktree[worktreeId]
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        delete nextActiveTabTypeByWorktree[worktreeId]
        const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
        delete nextActiveTabIdByWorktree[worktreeId]
        const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
        // Why: the mixed terminal/editor/browser tab strip persists visual order
        // per worktree. If a deleted worktree keeps its entry, stale tab IDs stay
        // retained indefinitely even though reconcileTabOrder filters them later.
        delete nextTabBarOrderByWorktree[worktreeId]
        const nextPendingReconnectTabByWorktree = { ...s.pendingReconnectTabByWorktree }
        delete nextPendingReconnectTabByWorktree[worktreeId]
        // Why: split-tab layout/group state is owned by the worktree. Leaving it
        // behind retains full tab chrome for terminals/editors/browser tabs that
        // no longer exist and makes a deleted worktree look restorable in session
        // state even though its backing entities were already removed.
        const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
        delete nextUnifiedTabsByWorktree[worktreeId]
        const nextGroupsByWorktree = { ...s.groupsByWorktree }
        delete nextGroupsByWorktree[worktreeId]
        const nextLayoutByWorktree = { ...s.layoutByWorktree }
        delete nextLayoutByWorktree[worktreeId]
        const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
        delete nextActiveGroupIdByWorktree[worktreeId]
        // Why: git status / compare caches are keyed by worktree and stop being
        // refreshed once the worktree is deleted. Remove them here so deleted
        // worktrees cannot retain stale conflict badges, branch diffs, or compare
        // request keys indefinitely in a long-lived renderer session.
        const nextGitStatusByWorktree = { ...s.gitStatusByWorktree }
        delete nextGitStatusByWorktree[worktreeId]
        const nextGitConflictOperationByWorktree = { ...s.gitConflictOperationByWorktree }
        delete nextGitConflictOperationByWorktree[worktreeId]
        const nextTrackedConflictPathsByWorktree = { ...s.trackedConflictPathsByWorktree }
        delete nextTrackedConflictPathsByWorktree[worktreeId]
        const nextGitBranchChangesByWorktree = { ...s.gitBranchChangesByWorktree }
        delete nextGitBranchChangesByWorktree[worktreeId]
        const nextGitBranchCompareSummaryByWorktree = { ...s.gitBranchCompareSummaryByWorktree }
        delete nextGitBranchCompareSummaryByWorktree[worktreeId]
        const nextGitBranchCompareRequestKeyByWorktree = {
          ...s.gitBranchCompareRequestKeyByWorktree
        }
        delete nextGitBranchCompareRequestKeyByWorktree[worktreeId]
        // Why: clean up per-file editor state for files belonging to the removed
        // worktree so stale drafts and view modes never accumulate in memory.
        const removedFileIds = new Set(
          s.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
        )
        const nextEditorDrafts = removedFileIds.size > 0 ? { ...s.editorDrafts } : s.editorDrafts
        const nextMarkdownViewMode =
          removedFileIds.size > 0 ? { ...s.markdownViewMode } : s.markdownViewMode
        if (removedFileIds.size > 0) {
          for (const fileId of removedFileIds) {
            delete nextEditorDrafts[fileId]
            delete nextMarkdownViewMode[fileId]
          }
        }
        const nextExpandedDirs = { ...s.expandedDirs }
        delete nextExpandedDirs[worktreeId]
        // If the active file belonged to the removed worktree, clear it
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && f.worktreeId === worktreeId)
          : false
        const removedActiveWorktree = s.activeWorktreeId === worktreeId
        return {
          worktreesByRepo: next,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          terminalLayoutsByTabId: nextLayouts,
          deleteStateByWorktreeId: nextDeleteState,
          fileSearchStateByWorktree: (() => {
            const nextSearch = { ...s.fileSearchStateByWorktree }
            // Why: file search UI state is worktree-scoped. Removing the worktree
            // must also remove its cached query/results so another worktree never
            // inherits stale matches from a path that no longer exists.
            delete nextSearch[worktreeId]
            return nextSearch
          })(),
          activeWorktreeId: removedActiveWorktree ? null : s.activeWorktreeId,
          activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: newOpenFiles,
          browserTabsByWorktree: nextBrowserTabsByWorktree,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeTabIdByWorktree: nextActiveTabIdByWorktree,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          pendingReconnectTabByWorktree: nextPendingReconnectTabByWorktree,
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          editorDrafts: nextEditorDrafts,
          markdownViewMode: nextMarkdownViewMode,
          expandedDirs: nextExpandedDirs,
          gitStatusByWorktree: nextGitStatusByWorktree,
          gitConflictOperationByWorktree: nextGitConflictOperationByWorktree,
          trackedConflictPathsByWorktree: nextTrackedConflictPathsByWorktree,
          gitBranchChangesByWorktree: nextGitBranchChangesByWorktree,
          gitBranchCompareSummaryByWorktree: nextGitBranchCompareSummaryByWorktree,
          gitBranchCompareRequestKeyByWorktree: nextGitBranchCompareRequestKeyByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
          activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType,
          sortEpoch: s.sortEpoch + 1
        }
      })
      return { ok: true as const }
    } catch (err) {
      console.error('Failed to remove worktree:', err)
      const error = err instanceof Error ? err.message : String(err)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [worktreeId]: {
            isDeleting: false,
            error,
            canForceDelete: !(force ?? false)
          }
        }
      }))
      return { ok: false as const, error }
    }
  },

  clearWorktreeDeleteState: (worktreeId) => {
    set((s) => {
      if (!s.deleteStateByWorktreeId[worktreeId]) {
        return {}
      }
      const next = { ...s.deleteStateByWorktreeId }
      delete next[worktreeId]
      return { deleteStateByWorktreeId: next }
    })
  },

  updateWorktreeMeta: async (worktreeId, updates) => {
    // Why: editing a comment is meaningful interaction with the worktree.
    // Without refreshing lastActivityAt, the time-decay score has decayed
    // since the previous sort, so a re-sort causes the worktree to drop in
    // ranking even though the user just touched it. Bumping the timestamp
    // keeps the recency signal fresh so the worktree holds its position.
    const enriched = 'comment' in updates ? { ...updates, lastActivityAt: Date.now() } : updates

    set((s) => {
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, enriched)
      return nextWorktrees === s.worktreesByRepo
        ? {}
        : { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
    })

    try {
      await window.api.worktrees.updateMeta({ worktreeId, updates: enriched })
    } catch (err) {
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    }
  },

  markWorktreeUnread: (worktreeId) => {
    // Why: BEL must fire regardless of focus (ghostty semantics — "show
    // until interact"). Interaction with a pane inside the worktree
    // dismisses the dot via clearWorktreeUnread. Worktree activation via
    // setActiveWorktree also clears isUnread as a side-effect; that path
    // predates this PR and is unaffected here.
    let shouldPersist = false
    const now = Date.now()
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
          isUnread: true,
          lastActivityAt: now
        }),
        sortEpoch: s.sortEpoch + 1
      }
    })

    if (!shouldPersist) {
      return
    }

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { isUnread: true, lastActivityAt: now } })
      .catch((err) => {
        console.error('Failed to persist unread worktree state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  clearWorktreeUnread: (worktreeId) => {
    let shouldPersist = false
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not `{}`) to preserve the exact object reference
        // on no-op. This matches the sibling `clearTerminalTabUnread` in
        // terminals.ts and avoids downstream selector churn on the hot path
        // (called on every keystroke and pointerdown).
        return s
      }
      shouldPersist = true
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
          isUnread: false
        })
      }
    })

    if (!shouldPersist) {
      return
    }

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { isUnread: false } })
      .catch((err) => {
        console.error('Failed to persist cleared unread worktree state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  bumpWorktreeActivity: (worktreeId) => {
    const now = Date.now()
    set((s) => {
      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      if (!worktree) {
        return {}
      }
      // Skip sortEpoch bump for the active worktree. Terminal events
      // (PTY spawn, PTY exit) in the active worktree are side-effects of
      // the user clicking the card or interacting with the terminal —
      // re-sorting the sidebar in response would cause the exact reorder-
      // on-click bug PR #209 intended to fix (e.g. dead-PTY reconnection
      // after generation bump triggers updateTabPtyId → here).
      // The lastActivityAt timestamp is still persisted so that the NEXT
      // meaningful sortEpoch bump (from a background worktree event) will
      // include this worktree's updated smart-sort score.
      const isActive = s.activeWorktreeId === worktreeId
      return {
        worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
          lastActivityAt: now
        }),
        ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
      }
    })

    void window.api.worktrees
      .updateMeta({ worktreeId, updates: { lastActivityAt: now } })
      .catch((err) => {
        console.error('Failed to persist worktree activity timestamp:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
  },

  setActiveWorktree: (worktreeId) => {
    const reconciledActiveTabId = worktreeId
      ? get().reconcileWorktreeTabModel(worktreeId).activeRenderableTabId
      : null
    let shouldClearUnread = false
    set((s) => {
      if (!worktreeId) {
        return {
          activeWorktreeId: null
        }
      }

      const worktree = findWorktreeById(s.worktreesByRepo, worktreeId)
      shouldClearUnread = Boolean(worktree?.isUnread)

      // Restore per-worktree editor state
      const restoredFileId = s.activeFileIdByWorktree[worktreeId] ?? null
      const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[worktreeId] ?? null
      const restoredTabType = s.activeTabTypeByWorktree[worktreeId] ?? 'terminal'
      const activeGroupId =
        s.activeGroupIdByWorktree[worktreeId] ?? s.groupsByWorktree[worktreeId]?.[0]?.id ?? null
      const activeGroup = activeGroupId
        ? ((s.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId) ??
          null)
        : null
      const activeUnifiedTabId = reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
      const activeUnifiedTab =
        activeUnifiedTabId != null
          ? ((s.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) =>
                tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
            ) ?? null)
          : null
      // Verify the restored file still exists in openFiles
      const fileStillOpen = restoredFileId
        ? s.openFiles.some((f) => f.id === restoredFileId && f.worktreeId === worktreeId)
        : false
      const browserTabs = s.browserTabsByWorktree[worktreeId] ?? []
      const browserTabStillOpen = restoredBrowserTabId
        ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
        : false
      const hasGroupOwnedSurface =
        (s.groupsByWorktree[worktreeId]?.length ?? 0) > 0 || Boolean(s.layoutByWorktree[worktreeId])

      // Why: worktree activation must restore from the reconciled tab-group
      // model first. Split groups are now the ownership model for visible
      // content; if we prefer the legacy activeTabType/browser/file fallbacks
      // when the two models disagree, the renderer can reopen a surface that
      // has no backing unified tab and show a blank worktree.
      let activeFileId: string | null
      let activeBrowserTabId: string | null
      let activeTabType: WorkspaceVisibleTabType
      if (activeUnifiedTab) {
        activeFileId =
          activeUnifiedTab.contentType === 'editor' ||
          activeUnifiedTab.contentType === 'diff' ||
          activeUnifiedTab.contentType === 'conflict-review'
            ? activeUnifiedTab.entityId
            : fileStillOpen
              ? restoredFileId
              : null
        activeBrowserTabId =
          activeUnifiedTab.contentType === 'browser'
            ? activeUnifiedTab.entityId
            : browserTabStillOpen
              ? restoredBrowserTabId
              : (browserTabs[0]?.id ?? null)
        activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
      } else if (hasGroupOwnedSurface) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'terminal') {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'terminal'
      } else if (restoredTabType === 'browser' && browserTabStillOpen) {
        activeFileId = fileStillOpen ? restoredFileId : null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (restoredTabType === 'editor' && fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
        activeTabType = 'editor'
      } else if (browserTabStillOpen) {
        activeFileId = null
        activeBrowserTabId = restoredBrowserTabId
        activeTabType = 'browser'
      } else if (fileStillOpen) {
        activeFileId = restoredFileId
        activeBrowserTabId = browserTabs[0]?.id ?? null
        activeTabType = 'editor'
      } else {
        const fallbackFile = s.openFiles.find((f) => f.worktreeId === worktreeId)
        const fallbackBrowserTab = browserTabs[0] ?? null
        activeFileId = fallbackFile?.id ?? null
        activeBrowserTabId = browserTabStillOpen
          ? restoredBrowserTabId
          : (fallbackBrowserTab?.id ?? null)
        activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
      }

      // Why: restore the last-active terminal tab for this worktree so the
      // user returns to the same tab they left, not always the first one.
      const restoredTabId = s.activeTabIdByWorktree[worktreeId] ?? null
      const worktreeTabs = s.tabsByWorktree[worktreeId] ?? []
      const tabStillExists = restoredTabId
        ? worktreeTabs.some((t) => t.id === restoredTabId)
        : false
      const activeTabId =
        activeUnifiedTab?.contentType === 'terminal'
          ? activeUnifiedTab.entityId
          : tabStillExists
            ? restoredTabId
            : (worktreeTabs[0]?.id ?? null)

      // Why: focusing a worktree is not meaningful background activity for the
      // smart sort. Writing lastActivityAt here makes the next unrelated
      // sortEpoch bump reshuffle cards based on what the user merely looked at,
      // which is the "jump after focus" bug reported in Slack. Keep selection
      // side-effects limited to unread clearing; true activity signals such as
      // PTY lifecycle and explicit edits still flow through bumpWorktreeActivity.
      const metaUpdates: Partial<WorktreeMeta> = shouldClearUnread ? { isUnread: false } : {}

      // Why: the generation bump for dead-PTY tabs MUST happen in the same
      // set() as the activation. Two separate set() calls let React/Zustand
      // render the old (dead-transport) TerminalPane as visible for one frame
      // before the generation bump unmounts it — that intermediate render
      // resumes the pane with a transport stuck at connected=false/ptyId=null,
      // and user input is silently dropped.
      const tabs = s.tabsByWorktree[worktreeId ?? ''] ?? []
      const allDead = worktreeId && tabs.length > 0 && tabs.every((tab) => !tab.ptyId)
      const tabsByWorktreeUpdate = allDead
        ? {
            tabsByWorktree: {
              ...s.tabsByWorktree,
              [worktreeId!]: tabs.map((tab) => ({
                ...tab,
                generation: (tab.generation ?? 0) + 1
              }))
            }
          }
        : {}

      return {
        activeWorktreeId: worktreeId,
        activeFileId,
        activeBrowserTabId,
        activeTabType,
        activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [worktreeId]: activeTabType },
        activeTabId,
        ...(shouldClearUnread
          ? { worktreesByRepo: applyWorktreeUpdates(s.worktreesByRepo, worktreeId, metaUpdates) }
          : {}),
        ...tabsByWorktreeUpdate
      }
    })

    // Why: force-refreshing GitHub data on every switch burned API rate limit
    // quota and added 200-800ms latency. Only refresh when cache is actually
    // stale (>5 min old). Users can still force-refresh via the sidebar button.
    if (worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }

    if (!worktreeId || !findWorktreeById(get().worktreesByRepo, worktreeId)) {
      return
    }

    if (shouldClearUnread) {
      const updates: Parameters<typeof window.api.worktrees.updateMeta>[0]['updates'] = {
        isUnread: false
      }

      void window.api.worktrees.updateMeta({ worktreeId, updates }).catch((err) => {
        console.error('Failed to persist worktree activation state:', err)
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      })
    }
  },

  allWorktrees: () => Object.values(get().worktreesByRepo).flat()
})

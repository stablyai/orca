import { useCallback } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { destroyWorkspaceWebviews } from '../../store/slices/browser-webview-cleanup'
import { requestEditorFileClose } from '../editor/editor-autosave'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'

export function useTabGroupTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review' ||
            item.contentType === 'check-details')
      )
      if (!otherReference) {
        const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === entityId)
        if (file?.isDirty) {
          // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
          requestEditorFileClose(entityId)
          return false
        }
        closeFile(entityId)
      }
      return true
    },
    [closeFile, worktreeId]
  )

  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [setActiveWorktree, worktreeId])

  const closeBrowserItem = useCallback(
    (item: Tab, focusedEnvironmentId: string | null | undefined) => {
      const state = useAppStore.getState()
      const plan = closeBrowserWorkspaceTabOnHosts({
        state,
        worktreeId,
        workspaceId: item.entityId,
        visibleTabId: item.id,
        focusedEnvironmentId
      })
      // Why: both teardown sites take the reason. closeBrowserTab usually removes the visible tab
      // itself, but when it cannot find it the bare call below is the one that runs — and a cleanup
      // close that lands there without these options hands the user an empty-worktree landing.
      const cleanupOptions =
        plan.localCloseReason === 'cleanup'
          ? { preserveWorktreeSelection: true, recordInteraction: false }
          : undefined
      if (plan.closesLocally) {
        // Why before the teardown: closeBrowserTab announces the MRU page selection, and a guest
        // torn down first leaves the fallback picking registration order instead (#16306).
        closeBrowserTab(
          item.entityId,
          plan.localCloseReason ? { reason: plan.localCloseReason } : undefined
        )
        destroyWorkspaceWebviews(state.browserPagesByWorkspace, item.entityId)
      }
      if (plan.removesVisibleTab) {
        closeUnifiedTab(item.id, cleanupOptions)
      }
      return plan
    },
    [closeBrowserTab, closeUnifiedTab, worktreeId]
  )

  const closeItem = useCallback(
    (itemId: string, opts?: { skipEmptyCheck?: boolean }) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      if (item.isPinned) {
        return
      }
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      if (item.contentType === 'terminal') {
        // Why: closeTerminalTab can defer behind a pin / running-process dialog, so the
        // empty check has to run on the actual close — never on cancel.
        closeTerminalTab(
          item.entityId,
          opts?.skipEmptyCheck ? undefined : { onClosed: leaveWorktreeIfEmpty }
        )
        return
      }
      if (item.contentType === 'browser') {
        const plan = closeBrowserItem(item, runtimeEnvironmentId)
        // Why: the empty check below answers "the user emptied this worktree". Unwinding a create
        // that never finished is not that — it must leave the selection as the click found it.
        if (!plan.closesLocally || plan.localCloseReason === 'cleanup') {
          return
        }
      } else if (item.contentType === 'simulator') {
        closeUnifiedTab(item.id)
      } else {
        const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
        if (!canCloseTab) {
          return
        }
        closeUnifiedTab(item.id)
      }
      if (!opts?.skipEmptyCheck) {
        leaveWorktreeIfEmpty()
      }
    },
    [
      closeBrowserItem,
      closeEditorIfUnreferenced,
      closeUnifiedTab,
      groupTabs,
      leaveWorktreeIfEmpty,
      worktreeId
    ]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item || item.isPinned) {
          continue
        }
        const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
          useAppStore.getState(),
          worktreeId
        )
        if (item.contentType === 'terminal' && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
          // Why: revoke local resume + hook authority before the host removes its canonical tab.
          // No running-process prompt: a bulk close of N busy tabs would be a modal storm.
          closeTerminalTab(item.entityId, { skipRunningProcessConfirm: true })
          continue
        }
        if (item.contentType === 'browser') {
          closeBrowserItem(item, runtimeEnvironmentId)
        } else if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'simulator') {
          closeUnifiedTab(item.id)
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (canCloseTab) {
            closeUnifiedTab(item.id)
          }
        }
      }
    },
    [closeBrowserItem, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs, worktreeId]
  )

  return { closeItem, closeMany, leaveWorktreeIfEmpty }
}

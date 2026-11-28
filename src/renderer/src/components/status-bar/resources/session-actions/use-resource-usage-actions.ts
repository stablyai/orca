import { selectWorktreesByRepo } from '../../../../store/workspaces/catalog/workspace-record-fields'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import {
  activateAndRevealWorkspace,
  activateAndRevealWorktree
} from '@/lib/workspace/activation/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../../../store/index'
import type { AppState } from '../../../../store/types'
import { getIndexedAllWorktrees } from '../../../../store/slices/worktrees/listing/worktree-catalog-index'
import { runWorktreeDelete } from '../../../sidebar/workspace-actions/deletion/delete-worktree-flow'
import { ORPHAN_WORKTREE_ID } from '../../../../../../shared/terminal/pty/orphan-worktree-id'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { UNATTRIBUTED_REPO_ID } from '../workspace-attribution/merge-snapshot-and-sessions'
import type { UnifiedSessionRow } from '../workspace-attribution/resource-usage-merge-types'
import type { PtyListedSession as DaemonSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'

import {
  type ResourceSessionBindingInputs,
  selectUnboundDaemonSessions
} from '../workspace-attribution/resource-session-bindings'
import { navigateResourceSessionToTab, openResourceChat } from './resource-session-navigation'
import { settleChatOpenFocus } from './resource-chat-open-focus'
import { requiresKillConfirmation } from './resource-session-kill-confirmation'
import { resolveResourceManagerWorktreeTarget } from './resource-manager-worktree-target'

export function useResourceUsageActions({
  setCollapsedRepos,
  setCollapsedWorktrees,
  setOpen,
  setActiveView,
  openModal,
  openSpacePage,
  refreshSessions,
  removeSession,
  removeSessions,
  sessions,
  resourceSessionBindings,
  workspaceSessionReady,
  sessionsRereading,
  killConfirm,
  setKillConfirm,
  setKilling,
  mountedRef,
  cancelPopoverBodyFocusFrame,
  popoverBodyRef,
  popoverBodyFocusFrameRef
}: {
  setCollapsedRepos: Dispatch<SetStateAction<Set<string>>>
  setCollapsedWorktrees: Dispatch<SetStateAction<Set<string>>>
  setOpen: Dispatch<SetStateAction<boolean>>
  setActiveView: AppState['setActiveView']
  openModal: AppState['openModal']
  openSpacePage: AppState['openSpacePage']
  refreshSessions: () => Promise<void>
  removeSession: (sessionId: string, incarnationId?: string) => void
  removeSessions: (sessions: readonly Pick<DaemonSession, 'id' | 'incarnationId'>[]) => void
  sessions: readonly DaemonSession[]
  resourceSessionBindings: ResourceSessionBindingInputs
  workspaceSessionReady: boolean
  /** The terminal list is being read again because it was outdated; its ownership evidence can't skip a confirm. */
  sessionsRereading: boolean
  killConfirm: UnifiedSessionRow | null
  setKillConfirm: Dispatch<SetStateAction<UnifiedSessionRow | null>>
  setKilling: Dispatch<SetStateAction<boolean>>
  mountedRef: MutableRefObject<boolean>
  cancelPopoverBodyFocusFrame: () => void
  popoverBodyRef: MutableRefObject<HTMLDivElement | null>
  popoverBodyFocusFrameRef: MutableRefObject<number | null>
}) {
  const [actionError, setActionError] = useState<string | null>(null)
  const toggleRepo = useCallback(
    (repoId: string): void => {
      setCollapsedRepos((prev) => {
        const next = new Set(prev)
        if (next.has(repoId)) {
          next.delete(repoId)
        } else {
          next.add(repoId)
        }
        return next
      })
    },
    [setCollapsedRepos]
  )

  const toggleWorktree = useCallback(
    (worktreeId: string): void => {
      setCollapsedWorktrees((prev) => {
        const next = new Set(prev)
        if (next.has(worktreeId)) {
          next.delete(worktreeId)
        } else {
          next.add(worktreeId)
        }
        return next
      })
    },
    [setCollapsedWorktrees]
  )

  // Why: keep popover open on worktree navigation so users can browse; onFocusOutside suppresses the bound-row focus transfer.
  const navigateToWorktree = useCallback((worktreeId: string): void => {
    if (worktreeId === ORPHAN_WORKTREE_ID || worktreeId.startsWith(`${UNATTRIBUTED_REPO_ID}::`)) {
      return
    }
    // Folder activation owns host/path gating; git-worktree target resolution cannot handle folder keys.
    if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
      activateAndRevealWorkspace(worktreeId)
      return
    }
    const target = resolveResourceManagerWorktreeTarget(
      worktreeId,
      getIndexedAllWorktrees(selectWorktreesByRepo(useAppStore.getState()))
    )
    if (!target) {
      return
    }
    activateAndRevealWorktree(worktreeId, { executionHostId: target.hostId })
  }, [])

  const navigateToTab = useCallback(
    (tabId: string, paneKey: string | null) => {
      navigateResourceSessionToTab(tabId, paneKey, {
        // Read at click time, so a tab title change doesn't replace this callback and redraw every row.
        tabsByWorktree: useAppStore.getState().tabsByWorktree,
        terminalLayoutsByTabId: useAppStore.getState().terminalLayoutsByTabId,
        setActiveView,
        activateAndRevealWorktree: navigateToWorktree,
        activateTabAndFocusPane
      })
    },
    [setActiveView, navigateToWorktree]
  )

  // Set while a chat row closes the panel, so the close leaves focus with the chat instead of the trigger.
  const chatOpenedRef = useRef(false)
  // The opener activates whatever it opens (a group member opens its room), so nothing is activated first.
  const openChat = useCallback(
    (worktreeId: string, agentSessionId: string, runtimeHostId?: string): void => {
      // Close first: an open panel keeps focus, so the chat's composer couldn't take it.
      chatOpenedRef.current = true
      setOpen(false)
      void openResourceChat(worktreeId, agentSessionId, runtimeHostId).then(() =>
        settleChatOpenFocus(worktreeId, agentSessionId)
      )
    },
    [setOpen]
  )
  /** True once after a chat row closed the panel. */
  const takeChatOpenedClose = useCallback((): boolean => {
    const opened = chatOpenedRef.current
    chatOpenedRef.current = false
    return opened
  }, [])

  const deleteWorktree = useCallback(
    (worktreeId: string): void => {
      const target = resolveResourceManagerWorktreeTarget(
        worktreeId,
        getIndexedAllWorktrees(selectWorktreesByRepo(useAppStore.getState()))
      )
      if (!target) {
        return
      }
      setOpen(false)
      runWorktreeDelete(worktreeId, { expectedHostId: target.hostId })
    },
    [setOpen]
  )

  const handleOpenWorkspaceCleanup = useCallback((): void => {
    setOpen(false)
    queueMicrotask(() => openModal('workspace-cleanup'))
  }, [openModal, setOpen])

  // Read when an end is asked for, so a reread starting or ending keeps these callbacks and their rows unchanged.
  const sessionsRereadingRef = useRef(sessionsRereading)
  useEffect(() => {
    sessionsRereadingRef.current = sessionsRereading
  }, [sessionsRereading])
  const handleKillSession = useCallback(
    (session: UnifiedSessionRow): void => {
      if (session.readOnly) {
        return
      }
      // A list being read again can't name which terminal holds this id, so it ends nothing.
      if (sessionsRereadingRef.current) {
        return
      }
      if (!requiresKillConfirmation(session)) {
        setActionError(null)
        // Why: await the kill before refreshing, else the refresh re-reads the daemon list before the kill lands and re-adds the row.
        void (async () => {
          try {
            await window.api.pty.kill(session.sessionId)
            removeSession(session.sessionId, session.incarnationId)
          } catch {
            setActionError(
              translate(
                'resourceManager.killFailed',
                'The terminal could not be ended. Last-observed sessions are retained.'
              )
            )
          }
          await refreshSessions()
        })()
        return
      }
      setKillConfirm(session)
    },
    [refreshSessions, removeSession, setKillConfirm]
  )

  const handleKillOrphans = useCallback(async () => {
    if (!workspaceSessionReady || sessionsRereadingRef.current) {
      return
    }
    // Use the badge’s exact orphan selector so bulk cleanup cannot destroy sessions excluded from its count.
    const orphans = selectUnboundDaemonSessions(sessions, resourceSessionBindings)
    if (orphans.length === 0) {
      return
    }
    setActionError(null)
    const results = await Promise.allSettled(orphans.map((s) => window.api.pty.kill(s.id)))
    removeSessions(orphans.filter((_session, index) => results[index]?.status === 'fulfilled'))
    if (results.some((result) => result.status === 'rejected')) {
      setActionError(
        translate(
          'resourceManager.killFailed',
          'The terminal could not be ended. Last-observed sessions are retained.'
        )
      )
    }
    void refreshSessions()
  }, [sessions, resourceSessionBindings, workspaceSessionReady, refreshSessions, removeSessions])

  const runKillConfirmed = useCallback(async () => {
    if (!killConfirm) {
      return
    }
    const target = killConfirm
    setKilling(true)
    setActionError(null)
    try {
      await window.api.pty.kill(target.sessionId)
      removeSession(target.sessionId, target.incarnationId)
    } catch {
      setActionError(
        translate(
          'resourceManager.killFailed',
          'The terminal could not be ended. Last-observed sessions are retained.'
        )
      )
    }
    if (mountedRef.current) {
      setKilling(false)
      setKillConfirm(null)
      // Why: killed row unmounts and focus would drop to <body>; park it on the popover body so keyboard users stay in the list.
      cancelPopoverBodyFocusFrame()
      if (popoverBodyRef.current) {
        popoverBodyFocusFrameRef.current = requestAnimationFrame(() => {
          popoverBodyFocusFrameRef.current = null
          popoverBodyRef.current?.focus()
        })
      }
      void refreshSessions()
    }
  }, [
    cancelPopoverBodyFocusFrame,
    killConfirm,
    mountedRef,
    popoverBodyFocusFrameRef,
    popoverBodyRef,
    refreshSessions,
    removeSession,
    setKillConfirm,
    setKilling
  ])

  const openSpaceResults = useCallback((): void => {
    setOpen(false)
    openSpacePage()
  }, [openSpacePage, setOpen])

  return {
    actionError,
    toggleRepo,
    toggleWorktree,
    navigateToWorktree,
    navigateToTab,
    openChat,
    takeChatOpenedClose,
    deleteWorktree,
    handleOpenWorkspaceCleanup,
    handleKillSession,
    handleKillOrphans,
    runKillConfirmed,
    openSpaceResults
  }
}

export type ResourceUsageActions = ReturnType<typeof useResourceUsageActions>

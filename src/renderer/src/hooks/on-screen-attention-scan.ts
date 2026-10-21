import {
  onScreenWorkspaceIds,
  resolveAutoAckTabTargets,
  type AutoAckTabTarget
} from './agent-auto-ack-targets'
import {
  captureAgentSubjectReads,
  sameStructuredReadTarget,
  type AgentSubjectRead,
  type StructuredSubjectRead
} from '@/attention/agent-subject-read-actions'
import {
  createAutoAckPresenceCheck,
  isPresenceConfirmed,
  notePresence,
  setPresenceGated
} from './agent-auto-ack-presence'
import type { AppState } from '@/store/types'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import {
  acknowledgeViewedAutoAckTarget,
  readAgentAttentionTurnRecords,
  surfaceForAutoAckTarget
} from './agent-auto-ack-surfaces'
import {
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections
} from '@/attention/agent-attention-acknowledgement'
import {
  isWorkspaceFlagSet,
  onScreenHostId
} from '@/store/slices/workspace-attention/workspace-unread-flag'
import { paneKeyTabId } from '@/store/slices/workspace-attention/workspace-live-markers'
import { isOrcaWindowForegroundFocused } from '@/components/terminal-pane/terminal-notification-pane-visibility'
import type { ClientWorkspaceViewReporter } from './client-workspace-view-report'

type ScanStore = {
  getState: () => AppState
  subscribe: (listener: () => void) => () => void
}

/**
 * The window the scan runs in. Window visibility+focus is read from the real document (the
 * characterization fixture stubs it), so marking and the scan share one window check.
 */
export type OnScreenAttentionEnvironment = {
  /** Null where there is no native idle query (browsers): the window gate stands alone. */
  readDesktopAway: (() => Promise<boolean | undefined>) | null
  subscribeStructuredViews: (onView: (view: StructuredSubjectRead) => void) => () => void
  /** `onRescan`: visibility/focus changed. `onInput`: trusted input proves presence. */
  subscribePresenceSignals: (onRescan: () => void, onInput: () => void) => () => void
  /** Where the owning hosts raise the unread flag, they learn what this window shows. */
  viewReporter?: ClientWorkspaceViewReporter
}

function hasMarkersOnScreen(s: AppState, targets: readonly AutoAckTabTarget[]): boolean {
  const tabIds = new Set(targets.map((target) => target.tabId))
  const onScreen = (paneKey: string): boolean => tabIds.has(paneKeyTabId(paneKey) ?? '')
  return (
    targets.some(({ tabId }) => Boolean(s.unreadTerminalTabs[tabId])) ||
    Object.keys(s.unreadTerminalPanes).some(onScreen) ||
    Object.keys(s.unreadAgentCompletionPanes).some(onScreen)
  )
}

/**
 * On screen means read: while the window is visible and focused and the user is present, the
 * agents on the visible tabs are acknowledged and every unread marker of those tabs is read.
 * Scans live + retained maps: Codex's title-revert (pty-connection.ts:onAgentExited) migrates `done` rows to retained mid-race — see docs/codex-agent-row-bold-stuck.md.
 */
export function startOnScreenAttentionScan(
  store: ScanStore,
  env: OnScreenAttentionEnvironment
): () => void {
  setPresenceGated(env.readDesktopAway !== null)
  // Why: the store uses plain create() (no subscribeWithSelector), so manually track the slices we depend on to skip unrelated updates.
  // Init to undefined so the first maybeAck() (on mount) always passes the ref guard and scans.
  let lastActiveView: unknown = undefined
  let lastActiveTabId: unknown = undefined
  let lastActiveWorktreeId: unknown = undefined
  let lastSplitViewPair: unknown = undefined
  let lastActiveHostId: unknown = undefined
  let lastActiveGroupIds: unknown = undefined
  let lastGroups: unknown = undefined
  let lastGroupLayouts: unknown = undefined
  let lastAgentStatus: unknown = undefined
  let lastRetained: unknown = undefined
  let lastAcknowledged: unknown = undefined
  let lastLayouts: unknown = undefined
  let lastUnreadTerminalTabs: unknown = undefined
  let lastUnreadTerminalPanes: unknown = undefined
  let lastUnreadAgentCompletionPanes: unknown = undefined
  let lastFloatingPanelVisible = false
  // The screen last read, or null when none has been read since the window or workspace left.
  let lastReadScreenKey: string | null = null

  // `force` re-scans after a presence signal the store never sees.
  let pendingPresenceReads: readonly AgentSubjectRead[] | undefined
  const presence = createAutoAckPresenceCheck(
    async () => env.readDesktopAway?.(),
    () => {
      const reads = pendingPresenceReads
      pendingPresenceReads = undefined
      maybeAck({ force: true, presenceConfirmed: true, reads })
    }
  )
  const maybeAck = (options?: {
    force?: boolean
    presenceConfirmed?: boolean
    reads?: readonly AgentSubjectRead[]
    view?: StructuredSubjectRead
  }): void => {
    const s = store.getState()
    // Why both edges: opening puts the floating tab on screen; closing moves the screen back.
    const floatingPanelVisible = selectFloatingWorkspacePanelVisible(s)
    const floatingPanelClosed = !floatingPanelVisible && lastFloatingPanelVisible
    const floatingPanelToggled = floatingPanelVisible !== lastFloatingPanelVisible
    lastFloatingPanelVisible = floatingPanelVisible
    if (
      !options?.force &&
      !floatingPanelToggled &&
      s.activeView === lastActiveView &&
      s.activeTabId === lastActiveTabId &&
      s.activeWorktreeId === lastActiveWorktreeId &&
      s.worktreeSplitViewPair === lastSplitViewPair &&
      s.activeWorkspaceExecutionHostId === lastActiveHostId &&
      s.activeGroupIdByWorktree === lastActiveGroupIds &&
      s.groupsByWorktree === lastGroups &&
      s.layoutByWorktree === lastGroupLayouts &&
      s.agentStatusByPaneKey === lastAgentStatus &&
      s.retainedAgentsByPaneKey === lastRetained &&
      s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
      s.terminalLayoutsByTabId === lastLayouts &&
      s.unreadTerminalTabs === lastUnreadTerminalTabs &&
      s.unreadTerminalPanes === lastUnreadTerminalPanes &&
      s.unreadAgentCompletionPanes === lastUnreadAgentCompletionPanes
    ) {
      return
    }

    // Presence signals force a rescan; unrelated writes must not retry an away result.
    lastActiveView = s.activeView
    lastActiveTabId = s.activeTabId
    lastActiveWorktreeId = s.activeWorktreeId
    lastSplitViewPair = s.worktreeSplitViewPair
    lastActiveHostId = s.activeWorkspaceExecutionHostId
    lastActiveGroupIds = s.activeGroupIdByWorktree
    lastGroups = s.groupsByWorktree
    lastGroupLayouts = s.layoutByWorktree
    lastAgentStatus = s.agentStatusByPaneKey
    lastRetained = s.retainedAgentsByPaneKey
    lastAcknowledged = s.acknowledgedAgentsByPaneKey
    lastLayouts = s.terminalLayoutsByTabId
    lastUnreadTerminalTabs = s.unreadTerminalTabs
    lastUnreadTerminalPanes = s.unreadTerminalPanes
    lastUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes

    // Why: tab-active only proxies "seen"; gate on window visible+focused so away-time transitions don't silently clear the bold signal.
    const workspaceIds = isOrcaWindowForegroundFocused() ? onScreenWorkspaceIds(s) : []
    // An editor, browser or empty workspace has no targets but still reads its flag on arrival.
    const targets = workspaceIds.length === 0 ? [] : resolveAutoAckTabTargets(s)
    env.viewReporter?.update(s, workspaceIds, targets)
    if (workspaceIds.length === 0) {
      lastReadScreenKey = null
      return
    }
    const screenKey = [
      s.activeWorkspaceExecutionHostId,
      ...workspaceIds,
      ...targets.map((target) => `${target.worktreeId}:${target.tabId}`)
    ].join('\n')
    const arrived = screenKey !== lastReadScreenKey
    const reads =
      options?.reads ??
      captureAgentSubjectReads(
        targets.flatMap((target) => {
          const key = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(target.tabId)
          return key ? [key] : []
        })
      ).map((read) => {
        const view = options?.view
        return view &&
          read.structured?.sessionId === view.sessionId &&
          sameStructuredReadTarget(read.structured.target, view.target)
          ? { ...read, structured: view }
          : read
      })
    if (!options?.presenceConfirmed && !isPresenceConfirmed()) {
      const records = readAgentAttentionTurnRecords(s)
      const hasAttention =
        hasMarkersOnScreen(s, targets) ||
        (arrived &&
          workspaceIds.some((workspaceId) =>
            isWorkspaceFlagSet(s, workspaceId, onScreenHostId(s, workspaceId))
          )) ||
        targets.some((target) => {
          const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(
            target.tabId
          )
          return (
            computeAgentAcknowledgementTargets(records, subjectKey).length > 0 ||
            (options?.force &&
              reads.some((read) => read.subjectKey === subjectKey && read.structured))
          )
        })
      if (hasAttention) {
        pendingPresenceReads = reads
        presence.request()
        return
      }
    }

    // Why before the writes below: they re-enter this scan synchronously, which must not see an arrival again.
    lastReadScreenKey = screenKey
    pendingPresenceReads = undefined
    // Why not with no target, nor on a panel close alone: an empty or non-agent view, or the tab
    // the user just closed the panel on, is not "moved on" — lapsing would drop a mark-unread.
    if (targets.length > 0 && !floatingPanelClosed) {
      const activeSubjectKeys = new Set<string>()
      for (const target of targets) {
        const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(target.tabId)
        if (subjectKey) {
          activeSubjectKeys.add(subjectKey)
        }
      }
      // Protection lapses when the user moves on to another subject or the agent takes a new
      // turn; a still-active subject with an unchanged turn keeps its explicit mark-unread.
      const lapsedProtections = computeLapsedManualUnreadProtections(
        {
          liveTurns: s.agentStatusByPaneKey,
          retainedTurns: s.retainedAgentsByPaneKey,
          manuallyUnreadTurnStartedAt: s.manuallyUnreadTurnsByPaneKey
        },
        activeSubjectKeys
      )
      if (lapsedProtections.length > 0) {
        s.clearManuallyUnreadTurns(lapsedProtections)
      }
    }

    for (const target of targets) {
      // Why re-read: acking target[0] writes to the store, which re-enters this scan synchronously
      // and may already have handled target[1]; `s` is a pre-write snapshot that would re-ack it.
      acknowledgeViewedAutoAckTarget(store.getState(), target, {
        reads,
        readViewed: options?.force
      })
    }
    store.getState().readOnScreenAttention({ workspaceIds, targets }, { screenArrived: arrived })
  }
  // Why: run once on mount to catch a restored session that already has agents on the visible tab.
  maybeAck({ force: true })
  // Subscribe to all store changes; the ref-equality guard above skips unrelated updates.
  const unsubscribe = store.subscribe(() => maybeAck())
  const stopViews = env.subscribeStructuredViews((view) => maybeAck({ force: true, view }))
  const stopPresenceSignals = env.subscribePresenceSignals(
    () => maybeAck({ force: true }),
    () => {
      notePresence()
      env.viewReporter?.renewPresence()
      // Why only while a presence check is parked: input is the hottest path in the app, and an
      // unparked rescan would only re-read the screen that store writes and views already read.
      if (pendingPresenceReads !== undefined) {
        pendingPresenceReads = undefined
        maybeAck({ force: true, presenceConfirmed: true })
      }
    }
  )
  return () => {
    presence.dispose()
    unsubscribe()
    stopViews()
    stopPresenceSignals()
    setPresenceGated(true)
  }
}

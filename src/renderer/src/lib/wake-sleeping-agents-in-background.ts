import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'

type BackgroundSleepingAgentWakeDispatcherOptions = {
  isWorkspaceSessionReady?: () => boolean
  subscribeToStore?: (listener: () => void) => () => void
  wake?: (worktreeId: string) => void
}

/**
 * Buffers main's one-shot mobile wake until persisted sleeping records exist.
 * Why: the renderer can attach its IPC listener before workspace hydration;
 * dropping an early event leaves the phone connected to frozen slept panes.
 */
export function createBackgroundSleepingAgentWakeDispatcher(
  options: BackgroundSleepingAgentWakeDispatcherOptions = {}
): { request: (worktreeId: string) => void; dispose: () => void } {
  const pendingWorktreeIds = new Set<string>()
  const isWorkspaceSessionReady =
    options.isWorkspaceSessionReady ?? (() => useAppStore.getState().workspaceSessionReady)
  const subscribeToStore =
    options.subscribeToStore ?? ((listener) => useAppStore.subscribe(listener))
  const wake = options.wake ?? wakeSleepingAgentsForWorktreeInBackground
  let unsubscribeReadiness: (() => void) | null = null
  let disposed = false

  const flushWhenReady = (): void => {
    if (disposed || !isWorkspaceSessionReady()) {
      return
    }
    const worktreeIds = [...pendingWorktreeIds]
    pendingWorktreeIds.clear()
    unsubscribeReadiness?.()
    unsubscribeReadiness = null
    for (const worktreeId of worktreeIds) {
      wake(worktreeId)
    }
  }

  return {
    request(worktreeId) {
      if (disposed || !worktreeId) {
        return
      }
      if (isWorkspaceSessionReady()) {
        wake(worktreeId)
        return
      }
      pendingWorktreeIds.add(worktreeId)
      unsubscribeReadiness ??= subscribeToStore(flushWhenReady)
    },
    dispose() {
      disposed = true
      pendingWorktreeIds.clear()
      unsubscribeReadiness?.()
      unsubscribeReadiness = null
    }
  }
}

function getSleepingRecordTabId(record: SleepingAgentSessionRecord): string | null {
  return (
    record.tabId ??
    parsePaneKey(record.paneKey)?.tabId ??
    parseLegacyNumericPaneKey(record.paneKey)?.tabId ??
    null
  )
}

function dispatchBackgroundMount(worktreeId: string, tabIds: readonly string[] | undefined): void {
  requestBackgroundTerminalWorktreeMount({ worktreeId, ...(tabIds ? { tabIds } : {}) })
}

function getCanonicalPassiveWakeRecords(
  records: readonly SleepingAgentSessionRecord[],
  alreadyClaimed: ReadonlySet<string>
): SleepingAgentSessionRecord[] {
  const activeClaimKeys = new Set(
    records
      .filter((record) => !isPassiveCompletedHibernationEvidence(record))
      .map(getProviderSessionClaimKey)
  )
  const recordsByClaim = new Map<string, SleepingAgentSessionRecord[]>()
  for (const record of records) {
    if (!isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    if (alreadyClaimed.has(claimKey) || activeClaimKeys.has(claimKey)) {
      continue
    }
    const grouped = recordsByClaim.get(claimKey) ?? []
    grouped.push(record)
    recordsByClaim.set(claimKey, grouped)
  }

  const canonicalRecords: SleepingAgentSessionRecord[] = []
  const duplicatePaneKeys: string[] = []
  const state = useAppStore.getState()
  for (const grouped of recordsByClaim.values()) {
    const ordered = grouped
      .slice()
      .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
    const liveTabIds = new Set(
      (state.tabsByWorktree[grouped[0]?.worktreeId ?? ''] ?? []).map((tab) => tab.id)
    )
    const canonical =
      ordered.find((record) => recordPaneIsOwnedByPreservedPane(record, state)) ??
      ordered.find((record) => {
        const tabId = getSleepingRecordTabId(record)
        return tabId !== null && liveTabIds.has(tabId)
      }) ??
      ordered.find((record) => getSleepingRecordTabId(record) !== null) ??
      ordered[0]
    if (!canonical) {
      continue
    }
    canonicalRecords.push(canonical)
    for (const duplicate of grouped) {
      if (duplicate !== canonical) {
        // Why: two cold panes mount after the event-scoped claim collector is
        // gone. Keep one provider-session record so only one can issue resume.
        duplicatePaneKeys.push(duplicate.paneKey)
      }
    }
  }
  state.clearSleepingAgentSessionsByPaneKey(duplicatePaneKeys)
  return canonicalRecords
}

/**
 * Wakes a worktree's slept agents on the desktop host renderer with NO desktop
 * navigation — used when a phone (`clientKind: 'mobile'`) opens the worktree.
 * Runs up to four steps, in order:
 *  (a) fire the armed cold-restore `--resume` of the worktree's mounted hidden
 *      hibernated panes (the experimental agent-sleep records; the primary
 *      wake mechanism, since those records are passive for path C). Panes that
 *      consume — or latch, when the wake races the hibernation kill — the
 *      in-place wake claim their provider sessions via the event detail;
 *  (b) background-mount the tabs holding passive hibernated records that are
 *      NOT currently mounted (post-restart / evicted) so they take the
 *      fresh-connect cold-restore path. The mount is targeted by tabId so one
 *      sleeping pane does not permanently mount every saved tab;
 *  (c) resume the non-passive record classes (manual sleep of a still-working
 *      agent, `origin: 'quit'`) with navigation suppressed, skipping the
 *      claims from (a);
 *  (d) background-mount the tabs (c) created — they are `activate: false`, so
 *      nothing else would mount them and their queued `--resume` startup
 *      would otherwise never reach a PTY.
 * Woken PTYs auto-publish to mobile via the renderer graph republish, so no
 * spawn is awaited.
 */
export function wakeSleepingAgentsForWorktreeInBackground(worktreeId: string): void {
  const worktreeRecords = Object.values(
    useAppStore.getState().sleepingAgentSessionsByPaneKey
  ).filter((record) => record.worktreeId === worktreeId)
  // Why: nothing is slept here, so there is no wake work. Skipping is what keeps
  // a phone browsing many worktrees from permanently background-mounting each one
  // (and reattaching its PTYs) on the desktop host it is paired to.
  if (worktreeRecords.length === 0) {
    return
  }

  const wokenClaimKeys = new Set<string>()
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
  // Why: only a passive completed-hibernation record has a not-yet-mounted pane
  // that needs a fresh-connect cold-restore (step b). Non-passive records are
  // recovered by step (c) into a fresh tab, mounted in step (d).
  const passiveTabIds = new Set<string>()
  let hasUntargetablePassiveRecord = false
  for (const record of getCanonicalPassiveWakeRecords(worktreeRecords, wokenClaimKeys)) {
    const tabId = getSleepingRecordTabId(record)
    if (tabId) {
      passiveTabIds.add(tabId)
    } else {
      hasUntargetablePassiveRecord = true
    }
  }
  if (passiveTabIds.size > 0 || hasUntargetablePassiveRecord) {
    // Why: a record whose tab cannot be resolved falls back to the untargeted
    // whole-worktree mount rather than silently never waking.
    dispatchBackgroundMount(
      worktreeId,
      hasUntargetablePassiveRecord ? undefined : [...passiveTabIds]
    )
  }
  const launchedTabIds: string[] = []
  resumeSleepingAgentSessionsForWorktree(worktreeId, {
    suppressNavigation: true,
    skipClaimKeys: wokenClaimKeys,
    onSessionLaunched: (tabId) => launchedTabIds.push(tabId)
  })
  if (launchedTabIds.length > 0) {
    dispatchBackgroundMount(worktreeId, launchedTabIds)
  }
}

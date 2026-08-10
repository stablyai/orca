import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { getSleepingAgentRemoteHydrationTargetId } from './sleeping-agent-remote-hydration-gate'
import { installSleepingAgentWakeIntentOwner } from './sleeping-agent-wake-intent'
import { subscribeToSleepingAgentHydrationTopology } from './sleeping-agent-hydration-topology-subscription'
import {
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'

const MAX_SETTLED_REMOTE_PULL_TARGETS = 256

type BackgroundSleepingAgentWakeDispatcherOptions = {
  isWorkspaceSessionReady?: () => boolean
  subscribeToStore?: (listener: () => void) => () => void
  wake?: (worktreeId: string) => void
  resume?: (worktreeId: string) => void
  getRemoteHydrationTargetId?: (worktreeId: string) => string | null
  remoteHydrationEnabled?: boolean
}

type DeferredWakeIntent = {
  targetId: string
  background: boolean
  activation: boolean
}

export type BackgroundSleepingAgentWakeDispatcher = {
  request: (worktreeId: string) => void
  requestActivation: (worktreeId: string) => boolean
  remotePullStarted: (targetId: string) => void
  remotePullSettled: (targetId: string) => void
  dispose: () => void
}

/**
 * Buffers main's one-shot mobile wake until persisted sleeping records exist.
 * Why: the renderer can attach its IPC listener before workspace hydration;
 * dropping an early event leaves the phone connected to frozen slept panes.
 */
export function createBackgroundSleepingAgentWakeDispatcher(
  options: BackgroundSleepingAgentWakeDispatcherOptions = {}
): BackgroundSleepingAgentWakeDispatcher {
  const pendingUntilReady = new Set<string>()
  const deferredByWorktreeId = new Map<string, DeferredWakeIntent>()
  const activePullCountByTargetId = new Map<string, number>()
  const settledPullTargetIds = new Set<string>()
  const isWorkspaceSessionReady =
    options.isWorkspaceSessionReady ?? (() => useAppStore.getState().workspaceSessionReady)
  const subscribeToStore =
    options.subscribeToStore ??
    ((listener) => subscribeToSleepingAgentHydrationTopology(useAppStore, listener))
  const wake = options.wake ?? wakeSleepingAgentsForWorktreeInBackground
  const resume =
    options.resume ??
    ((worktreeId) =>
      resumeSleepingAgentSessionsForWorktree(worktreeId, {
        skipRemoteHydrationDeferral: true
      }))
  const getRemoteHydrationTargetId =
    options.getRemoteHydrationTargetId ??
    ((worktreeId) => getSleepingAgentRemoteHydrationTargetId(useAppStore.getState(), worktreeId))
  const remoteHydrationEnabled = options.remoteHydrationEnabled ?? true
  let unsubscribeStore: (() => void) | null = null
  let disposed = false

  const replay = (worktreeId: string, intent: DeferredWakeIntent): void => {
    deferredByWorktreeId.delete(worktreeId)
    if (intent.background) {
      wake(worktreeId)
    } else if (intent.activation) {
      resume(worktreeId)
    }
  }

  const updateSubscription = (): void => {
    const needsSubscription = pendingUntilReady.size > 0 || deferredByWorktreeId.size > 0
    if (needsSubscription && !unsubscribeStore) {
      unsubscribeStore = subscribeToStore(flush)
    } else if (!needsSubscription && unsubscribeStore) {
      unsubscribeStore()
      unsubscribeStore = null
    }
  }

  const defer = (worktreeId: string, kind: 'activation' | 'background'): boolean => {
    if (!remoteHydrationEnabled) {
      return false
    }
    const targetId = getRemoteHydrationTargetId(worktreeId)
    if (!targetId) {
      return false
    }
    if (
      settledPullTargetIds.has(targetId) &&
      (activePullCountByTargetId.get(targetId) ?? 0) === 0
    ) {
      return false
    }
    const current = deferredByWorktreeId.get(worktreeId)
    deferredByWorktreeId.set(worktreeId, {
      targetId,
      background: current?.background === true || kind === 'background',
      activation: current?.activation === true || kind === 'activation'
    })
    updateSubscription()
    return true
  }

  function flush(): void {
    if (disposed) {
      return
    }
    if (isWorkspaceSessionReady()) {
      const readyWorktreeIds = [...pendingUntilReady]
      pendingUntilReady.clear()
      for (const worktreeId of readyWorktreeIds) {
        if (!defer(worktreeId, 'background')) {
          wake(worktreeId)
        }
      }
    }
    for (const [worktreeId, intent] of deferredByWorktreeId) {
      const targetId = getRemoteHydrationTargetId(worktreeId)
      if (!targetId) {
        replay(worktreeId, intent)
      } else if (targetId !== intent.targetId) {
        deferredByWorktreeId.set(worktreeId, { ...intent, targetId })
      }
    }
    updateSubscription()
  }

  let uninstallIntentOwner = (): void => {}

  const dispatcher: BackgroundSleepingAgentWakeDispatcher = {
    request(worktreeId) {
      if (disposed || !worktreeId) {
        return
      }
      if (!isWorkspaceSessionReady()) {
        pendingUntilReady.add(worktreeId)
        updateSubscription()
      } else if (!defer(worktreeId, 'background')) {
        wake(worktreeId)
      }
    },
    requestActivation(worktreeId) {
      return !disposed && defer(worktreeId, 'activation')
    },
    remotePullStarted(targetId) {
      if (!disposed) {
        settledPullTargetIds.delete(targetId)
        activePullCountByTargetId.set(targetId, (activePullCountByTargetId.get(targetId) ?? 0) + 1)
      }
    },
    remotePullSettled(targetId) {
      if (disposed) {
        return
      }
      const remaining = Math.max(0, (activePullCountByTargetId.get(targetId) ?? 1) - 1)
      if (remaining > 0) {
        activePullCountByTargetId.set(targetId, remaining)
        return
      }
      activePullCountByTargetId.delete(targetId)
      if (settledPullTargetIds.size >= MAX_SETTLED_REMOTE_PULL_TARGETS) {
        const oldestTargetId = settledPullTargetIds.values().next().value
        if (oldestTargetId) {
          settledPullTargetIds.delete(oldestTargetId)
        }
      }
      settledPullTargetIds.add(targetId)
      flush()
      for (const [worktreeId, intent] of deferredByWorktreeId) {
        if (intent.targetId === targetId) {
          replay(worktreeId, intent)
        }
      }
      updateSubscription()
    },
    dispose() {
      disposed = true
      pendingUntilReady.clear()
      deferredByWorktreeId.clear()
      activePullCountByTargetId.clear()
      settledPullTargetIds.clear()
      unsubscribeStore?.()
      unsubscribeStore = null
      uninstallIntentOwner()
    }
  }
  uninstallIntentOwner = installSleepingAgentWakeIntentOwner({
    deferActivation: dispatcher.requestActivation
  })
  return dispatcher
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
 *      sleeping pane does not permanently mount every saved tab, and skips
 *      `restoreOnTabOpenOnly` records so an explicit workspace sleep is not
 *      undone wholesale by a phone opening the workspace;
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
  // Why: a workspace the user explicitly slept must not respawn every finished agent because a
  // phone opened it. Those panes cold-restore `--resume` when their own tab is opened, which is
  // also what the desktop does (#11598). Filtering before canonicalization keeps a lazy record
  // from winning — and deleting — the claim of a hibernated record that does need mounting.
  const backgroundWakeRecords = worktreeRecords.filter(
    (record) => record.restoreOnTabOpenOnly !== true
  )
  for (const record of getCanonicalPassiveWakeRecords(backgroundWakeRecords, wokenClaimKeys)) {
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
    skipRemoteHydrationDeferral: true,
    skipClaimKeys: wokenClaimKeys,
    onSessionLaunched: (tabId) => launchedTabIds.push(tabId)
  })
  if (launchedTabIds.length > 0) {
    dispatchBackgroundMount(worktreeId, launchedTabIds)
  }
}

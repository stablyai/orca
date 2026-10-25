import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { isWorkspaceSleepRecord } from '../../../shared/workspace-sleep'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { getSleepingRecordTabId } from './sleeping-agent-wake-requests'
import { resolveActivationPtyListScope } from './worktree-activation-pty-inventory'
import { gateWorktreeAgentActivation } from './worktree-agent-activation-gate'
import {
  getProviderSessionClaimKey,
  activationTreatsNoteAsFinished,
  isStrandedWorkspaceSleepRecord,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'

type BackgroundSleepingAgentWakeDispatcherOptions = {
  isWorkspaceSessionReady?: () => boolean
  subscribeToStore?: (listener: () => void) => () => void
  wake?: (worktreeId: string) => void
}

/** Buffer main’s one-shot mobile wake until sleeping records hydrate; early listener attachment otherwise drops the only event and leaves frozen panes. */
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

function dispatchBackgroundMount(worktreeId: string, tabIds: readonly string[] | undefined): void {
  requestBackgroundTerminalWorktreeMount({ worktreeId, ...(tabIds ? { tabIds } : {}) })
}

function getCanonicalPassiveWakeRecords(
  records: readonly SleepingAgentSessionRecord[],
  alreadyClaimed: ReadonlySet<string>
): SleepingAgentSessionRecord[] {
  const activeClaimKeys = new Set(
    records
      .filter((record) => !activationTreatsNoteAsFinished(record))
      .map(getProviderSessionClaimKey)
  )
  const recordsByClaim = new Map<string, SleepingAgentSessionRecord[]>()
  for (const record of records) {
    if (!activationTreatsNoteAsFinished(record)) {
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
        // Canonicalize provider sessions before cold panes mount after event claims expire, preventing duplicate resumes.
        duplicatePaneKeys.push(duplicate.paneKey)
      }
    }
  }
  state.clearSleepingAgentSessionsByPaneKey(duplicatePaneKeys)
  return canonicalRecords
}

/** Wake mobile-visible sleepers without desktop navigation: wake mounted hibernated panes and collect claims; target-mount unmounted passive hibernation tabs; resume other records without navigation, skipping claims; mount those activate:false resume tabs so startup reaches PTYs. Skip restoreOnTabOpenOnly records to preserve explicit sleep. PTYs republish automatically, so await no spawn. */
export function wakeSleepingAgentsForWorktreeInBackground(worktreeId: string): void {
  const sleptRecords = Object.values(useAppStore.getState().sleepingAgentSessionsByPaneKey).filter(
    (record) => record.worktreeId === worktreeId
  )
  // No sleepers means no mounting: phone browsing must not accumulate desktop workspaces/PTYS.
  if (sleptRecords.length === 0) {
    return
  }

  // Why all records: a workspace sleep's still-mounted panes wake here too, through main's resume.
  const wokenClaimKeys = new Set<string>()
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
  // Why: main resumes a workspace sleep's placed records; the steps below are the window's own hibernation and stranded sleeps.
  const state = useAppStore.getState()
  const worktreeRecords = sleptRecords.filter(
    (record) => !isWorkspaceSleepRecord(record) || isStrandedWorkspaceSleepRecord(record, state)
  )
  if (worktreeRecords.length === 0) {
    return
  }
  // Only passive completed-hibernation records need fresh-connect mounting; nonpassive recovery creates/mounts new tabs later.
  const passiveTabIds = new Set<string>()
  let hasUntargetablePassiveRecord = false
  // Phone workspace opens must preserve explicit sleep until each tab opens (#11598). Filter before canonicalization so lazy records cannot steal/delete active hibernation claims.
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
    // If tab identity is unresolved, mount the whole workspace rather than strand recovery.
    dispatchBackgroundMount(
      worktreeId,
      hasUntargetablePassiveRecord ? undefined : [...passiveTabIds]
    )
  }
  const resumeOptions = {
    suppressNavigation: true,
    skipClaimKeys: wokenClaimKeys,
    // Mirror-deferred sweeps replay after this call; request each tab’s mount instead of collecting one early batch.
    onSessionLaunched: (tabId: string) => dispatchBackgroundMount(worktreeId, [tabId])
  }
  // Inactive panes look unowned locally even with live host PTYs; require host inventory to prove exit (STA-3859). Paired runtimes instead retain per-pane mirror parking.
  if (resolveActivationPtyListScope(useAppStore.getState(), worktreeId)) {
    void gateWorktreeAgentActivation(worktreeId, resumeOptions)
    return
  }
  resumeSleepingAgentSessionsForWorktree(worktreeId, resumeOptions)
}

import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import { useAppStore } from '@/store/index'
import { isWorkspaceSleepRecord } from '../../../../../shared/workspace/lifecycle/workspace-sleep'
import { getProviderSessionClaimKey } from '../../../../../shared/agent-session/lifecycle/resume/sleeping-record-legacy-pane-key'
import {
  activationTreatsNoteAsFinished,
  paneWillConnectOnActivation,
  recordPaneCanColdRestoreInPlace
} from './sleeping-agent-pane-ownership'
import {
  getSleepingRecordTabId,
  requestSleepingAgentWakeOnMount,
  takeSleepingAgentWakeRequest
} from './sleeping-agent-wake-requests'

/**
 * Wakes the preserved panes of records whose own pane must cold-restore them, and mounts those panes when
 * activation will not mount them itself. The wake-on-mount mark is what the resume sweep reads as pane
 * ownership, which is what stops it from forking a duplicate resume tab (#36623).
 *
 * Only call with host-claimed keys from the activation inventory: a mounted pane starts its `--resume`
 * writer, so records the host still holds as live sessions must not mount a second one (STA-3859).
 * Returns how many panes it woke, so an activation gate counts an in-place wake as recovery work.
 */
export function requestInPlaceResumeMounts(
  worktreeId: string,
  hostClaimedKeys: ReadonlySet<string>
): number {
  const state = useAppStore.getState()
  const tabIds = new Set<string>()
  for (const [, record] of sleepingAgentRecordIndex.entries(
    state.sleepingAgentSessionsByPaneKey,
    worktreeId
  )) {
    // A mark from an earlier activation would let this pane start a second writer on connect (STA-3859).
    if (hostClaimedKeys.has(getProviderSessionClaimKey(record))) {
      takeSleepingAgentWakeRequest(record)
      continue
    }
    if (
      record.worktreeId !== worktreeId ||
      // Explicit sleep waits for its own tab open (#11598); finished history is display-only, and main owns workspace sleep.
      activationTreatsNoteAsFinished(record) ||
      record.restoreOnTabOpenOnly === true ||
      isWorkspaceSleepRecord(record) ||
      !recordPaneCanColdRestoreInPlace(record, state)
    ) {
      continue
    }
    const tabId = getSleepingRecordTabId(record)
    // Why skip mounted tabs: their pane already ran its connect (or holds the record itself), so a
    // mark nothing would consume would only strand the record behind the sweep's ownership check.
    // A pending startup command wins the pane's start over the cold restore, so leave that tab to the sweep too.
    if (
      tabId !== null &&
      !hasRegisteredRuntimeTerminalTab(tabId, worktreeId) &&
      !state.pendingStartupByTabId[tabId]
    ) {
      tabIds.add(tabId)
    }
  }
  if (tabIds.size === 0) {
    return 0
  }
  const targets = [...tabIds]
  // Why the claim filter on marking too: a host-claimed record can share a mounted tab with an
  // unclaimed one, and waking its pane would start a second `--resume` writer (STA-3859).
  requestSleepingAgentWakeOnMount(worktreeId, targets, { skipClaimKeys: hostClaimedKeys })
  // An active worktree mounts these panes itself; only one activation will not mount needs the request,
  // which must stay targeted so a whole-worktree mount cannot spawn every saved tab.
  const unactivatedTabIds = targets.filter(
    (tabId) => !paneWillConnectOnActivation(worktreeId, tabId, state)
  )
  if (unactivatedTabIds.length > 0) {
    requestBackgroundTerminalWorktreeMount(
      { worktreeId, tabIds: unactivatedTabIds },
      hostClaimedKeys
    )
  }
  return targets.length
}

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

/** Resumes records in their own preserved pane (#36623), skipping host-claimed keys (STA-3859). */
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
    // Mounted tabs and pending startup commands would never spend a mark; leave them to the sweep.
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
  // A claimed record can share a tab with an unclaimed one; waking it adds a writer (STA-3859).
  requestSleepingAgentWakeOnMount(worktreeId, targets, { skipClaimKeys: hostClaimedKeys })
  // Active worktrees mount these panes themselves; request only the rest, never a whole worktree.
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

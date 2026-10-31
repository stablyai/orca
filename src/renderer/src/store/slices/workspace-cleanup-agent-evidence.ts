import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/structured-agent-session-tabs'
import type { AppState } from '../types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import {
  buildActivityTabHostIndex,
  resolveActivityExecutionHostId
} from '@/components/activity/activity-event-builder-context'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from '@/components/sidebar/worktree-agent-row-selectors'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { translate } from '@/i18n/i18n'
import { getWorkspaceCleanupAgentStartedFailure } from './workspace-cleanup-preflight-failures'
import { selectDetectedWorktreesByRepo, selectWorktreesByRepo } from '../workspace-record-selectors'

export function assertWorkspaceCleanupAgentStopApproved(
  state: AppState,
  candidate: WorkspaceCleanupCandidate,
  approvedCandidate: WorkspaceCleanupCandidate | undefined
): void {
  const evidence = getWorkspaceCleanupAgentEvidence(state, [candidate]).get(
    getWorkspaceCleanupCandidateIdentity(candidate)
  )
  if (evidence === 'unknown') {
    throw new Error(
      translate(
        'auto.store.slices.workspace.cleanup.hostUnresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'
      )
    )
  }
  if (evidence === 'live' && !approvedCandidate?.blockers.includes('live-agent')) {
    throw new Error(
      getWorkspaceCleanupAgentStartedFailure(
        {
          ...candidate,
          executionHostId: resolveWorkspaceCleanupRemovalHostId(candidate)
        },
        candidate
      ).message
    )
  }
}

/** Missing ownership remains a refusal, rather than becoming another host's agent or idle. */
export function getWorkspaceCleanupAgentEvidence(
  state: AppState,
  candidates: readonly WorkspaceCleanupCandidate[]
): Map<string, 'live' | 'unknown'> {
  const evidence = new Map<string, 'live' | 'unknown'>()
  let hostIndex: ReturnType<typeof buildActivityTabHostIndex> | undefined
  const candidatesByWorktreeId = new Map<string, WorkspaceCleanupCandidate[]>()
  for (const candidate of candidates) {
    const group = candidatesByWorktreeId.get(candidate.worktreeId) ?? []
    group.push(candidate)
    candidatesByWorktreeId.set(candidate.worktreeId, group)
  }
  for (const [worktreeId, worktreeCandidates] of candidatesByWorktreeId) {
    const rows = buildWorktreeAgentRows({
      tabs: state.tabsByWorktree[worktreeId] ?? [],
      representedTabs: state.unifiedTabsByWorktree
        ? getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree)
        : undefined,
      entries: selectLiveAgentStatusEntriesForWorktree(state, worktreeId),
      retained: selectRetainedAgentEntriesForWorktree(state, worktreeId),
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      now: Date.now()
    })
    const owners = new Map(
      rows.filter((row) => row.rowSource !== 'subagent').map((row) => [row.paneKey, row])
    )
    for (const row of rows) {
      if (row.state !== 'working' && row.state !== 'blocked' && row.state !== 'waiting') {
        continue
      }
      // Synthetic children display work owned by their actual parent pane.
      const owner = row.rowSource === 'subagent' ? owners.get(row.activationPaneKey ?? '') : row
      hostIndex ??= buildActivityTabHostIndex(state.unifiedTabsByWorktree)
      const leafId = owner && parsePaneKey(owner.paneKey)?.leafId
      const ptyIds = (owner && state.ptyIdsByTabId[owner.tab.id]) ?? []
      const ptyId =
        (owner &&
          leafId &&
          state.terminalLayoutsByTabId?.[owner.tab.id]?.ptyIdsByLeafId?.[leafId]) ||
        owner?.tab.ptyId ||
        owner?.entry.terminalHandle ||
        (ptyIds.length === 1 ? ptyIds[0] : undefined)
      const hostId = owner
        ? resolveActivityExecutionHostId(
            { worktreeId, tab: owner.tab },
            owner.entry,
            ptyId,
            hostIndex
          )
        : undefined
      for (const candidate of worktreeCandidates) {
        const identity = getWorkspaceCleanupCandidateIdentity(candidate)
        const candidateHost = resolveWorkspaceCleanupRemovalHostId(candidate)
        if (!hostId || !candidateHost) {
          evidence.set(identity, 'unknown')
        } else {
          const owner =
            findIndexedWorktreeOwnerForHost(
              selectWorktreesByRepo(state),
              worktreeId,
              candidateHost
            ) ??
            findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), worktreeId).find(
              (worktree) => isExecutionHostAliasForWorktree(candidateHost, worktree)
            )
          if (isExecutionHostAliasForWorktree(hostId, owner ?? { hostId: candidateHost })) {
            if (evidence.get(identity) !== 'unknown') {
              evidence.set(identity, 'live')
            }
          }
        }
      }
    }
  }
  return evidence
}

import type { AppState } from '../../types'
import { parseAgentStatusPaneIdentity } from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { compareWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-order'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { agentTypeToIconAgent } from '../../../../../shared/agent-status/presentation/agent-type-icon-agent'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../shared/structural-value-equality'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { EMPTY_KEYS } from './agent-status-projection-types'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionTopology } from './agent-status-projection-topology'
import type { ProjectionRows } from './agent-status-projection-rows'
import { agentRowEntriesEqual } from '@/components/sidebar/workspace-card/activity/worktree-agent-live-index-patch'

export function publishProjectionRows(
  data: AgentStatusProjectionState,
  state: AppState,
  topology: ProjectionTopology,
  rows: ProjectionRows
): Set<string> {
  const { moved, acceptedKeys, now, ownerOf } = topology
  const { prepared } = rows
  const arrange = new Set<string>()
  for (const [key, next] of prepared) {
    data.replaceContribution(key, next.contribution)
    const oldKeys = data.rowsForSource.get(key) ?? EMPTY_KEYS,
      oldOwner = data.ownerForSource.get(key)
    for (const rowKey of oldKeys) {
      if (oldOwner !== next.worktreeId || !next.rows.some((row) => row.paneKey === rowKey)) {
        if (oldOwner) {
          const b = data.worktrees.get(oldOwner)!
          b.keys.delete(rowKey)
          b.revision = ++data.nextRowRevision
          arrange.add(oldOwner)
          data.notices.add(`row\0${rowKey}`)
          data.notices.add(`list\0${oldOwner}`)
        }
        data.rows.delete(rowKey)
      }
    }
    for (const row of next.rows) {
      if (!next.worktreeId) {
        continue
      }
      const b = data.getBucket(next.worktreeId),
        prior = data.rows.get(row.paneKey)
      if (
        !b.keys.has(row.paneKey) ||
        !prior ||
        compareWorktreeAgentRows(prior, row) !== 0 ||
        prior.entry.orchestration?.parentPaneKey !== row.entry.orchestration?.parentPaneKey ||
        prior.entry.terminalHandle !== row.entry.terminalHandle ||
        prior.entry.orchestration?.parentTerminalHandle !==
          row.entry.orchestration?.parentTerminalHandle ||
        prior.entry.orchestration?.coordinatorHandle !== row.entry.orchestration?.coordinatorHandle
      ) {
        arrange.add(next.worktreeId)
      }
      b.keys.add(row.paneKey)
      if (
        !prior ||
        !agentRowEntriesEqual(prior.entry, row.entry) ||
        !equal(prior, { ...row, entry: prior.entry, lineage: prior.lineage })
      ) {
        data.rows.set(row.paneKey, prior?.lineage ? { ...row, lineage: prior.lineage } : row)
        b.revision = ++data.nextRowRevision
        data.notices.add(`row\0${row.paneKey}`)
        data.notices.add(`list\0${next.worktreeId}`)
      }
    }
    if (next.rows.length && next.worktreeId) {
      data.rowsForSource.set(
        key,
        next.rows.map((row) => row.paneKey)
      )
      data.ownerForSource.set(key, next.worktreeId)
    } else {
      data.rowsForSource.delete(key)
      data.ownerForSource.delete(key)
    }
    const mobileBefore = data.mobileOwners.get(key)
    const mobileAfter =
      state.agentStatusByPaneKey.has(key) && next.tabId && data.tabs.has(next.tabId)
        ? data.tabWorktrees.get(next.tabId)
        : undefined
    if (mobileBefore !== mobileAfter) {
      if (mobileBefore) {
        const keys = data.mobileKeys.get(mobileBefore)
        keys?.delete(key)
        if (!keys?.size) {
          data.mobileKeys.delete(mobileBefore)
          data.mobileOutputs.delete(mobileBefore)
        }
      }
      if (mobileAfter) {
        const keys = data.mobileKeys.get(mobileAfter) ?? new Set<string>()
        keys.add(key)
        data.mobileKeys.set(mobileAfter, keys)
        data.mobileOwners.set(key, mobileAfter)
      } else {
        data.mobileOwners.delete(key)
      }
    }
    if (mobileBefore && (mobileBefore !== mobileAfter || acceptedKeys.has(key))) {
      data.mobileOutputs.delete(mobileBefore)
    }
    if (mobileAfter && (mobileBefore !== mobileAfter || acceptedKeys.has(key))) {
      data.mobileOutputs.delete(mobileAfter)
    }
    const entry = state.agentStatusByPaneKey.get(key)
    const beforeHandle = data.handleByKey.get(key),
      afterHandle = entry?.terminalHandle
    if (beforeHandle !== afterHandle) {
      if (beforeHandle) {
        const keys = data.keysByHandle.get(beforeHandle)
        keys?.delete(key)
        if (!keys?.size) {
          data.keysByHandle.delete(beforeHandle)
        }
      }
      if (afterHandle) {
        const keys = data.keysByHandle.get(afterHandle) ?? new Set<string>()
        keys.add(key)
        data.keysByHandle.set(afterHandle, keys)
        data.handleByKey.set(key, afterHandle)
      } else {
        data.handleByKey.delete(key)
      }
    }
    const priorOrphanOwner = data.orphanOwners.get(key)
    if (priorOrphanOwner) {
      const keys = data.orphansByOwner.get(priorOrphanOwner)
      keys?.delete(key)
      if (!keys?.size) {
        data.orphansByOwner.delete(priorOrphanOwner)
      }
      data.orphanOwners.delete(key)
    }
    if (entry?.state === 'done' && entry.worktreeId && next.tabId && !ownerOf(next.tabId)) {
      const keys = data.orphansByOwner.get(entry.worktreeId) ?? new Set<string>()
      keys.add(key)
      data.orphansByOwner.set(entry.worktreeId, keys)
      data.orphanOwners.set(key, entry.worktreeId)
    }
    const priorIcon = data.icons.get(key)
    const oldTab = parseAgentStatusPaneIdentity(key, data.represented.get(key))?.tabId
    if ((!entry || moved.has(key)) && oldTab) {
      const keys = data.acceptedByTab.get(oldTab)
      keys?.delete(key)
      if (!keys?.size) {
        data.acceptedByTab.delete(oldTab)
      }
    }
    if (entry && next.tabId) {
      const keys = data.acceptedByTab.get(next.tabId) ?? new Set()
      keys.add(key)
      data.acceptedByTab.set(next.tabId, keys)
    }
    if (moved.has(key)) {
      data.ranks.delete(key)
    }
    if (entry && !data.ranks.has(key)) {
      data.ranks.set(key, data.nextRank++)
    }
    if (!entry) {
      data.ranks.delete(key)
    }
    data.deadCandidates.delete(key)
    data.freshCandidates.delete(key)
    data.candidateExpiries.delete(key)
    if (next.candidate) {
      const candidate = { ...next.candidate, rank: data.ranks.get(key) ?? 0 }
      data.candidates.set(key, candidate)
      if (candidate.dead || now - candidate.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
        data.deadCandidates.set(key, candidate.rank)
      } else {
        data.freshCandidates.set(key, candidate.rank)
        data.candidateExpiries.set(key, candidate.updatedAt + AGENT_STATUS_STALE_AFTER_MS)
      }
    } else {
      data.candidates.delete(key)
    }
    const agent = agentTypeToIconAgent(entry?.agentType),
      parsed = parsePaneKey(key)
    const icon =
      agent && entry && parsed
        ? {
            tabId: parsed.tabId,
            done: entry.state === 'done',
            pane: { leafId: parsed.leafId, agent }
          }
        : undefined
    if (moved.has(key) || !equal(priorIcon, icon)) {
      if (priorIcon) {
        data.replaceIcon(key, priorIcon, false)
      }
      if (icon) {
        data.icons.set(key, icon)
        data.replaceIcon(key, icon, true)
      } else {
        data.icons.delete(key)
      }
    }
  }
  return arrange
}

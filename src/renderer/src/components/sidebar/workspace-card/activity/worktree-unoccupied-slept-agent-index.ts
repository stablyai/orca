import { readRecordChanges } from '@/store/keyed-record-change-reads'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  sleptAgentEntriesByWorktree,
  sleptAgentWorktreeForPane,
  type SleepRowsState
} from './worktree-slept-agent-index'

let masked:
  | {
      live: AppState['agentStatusByPaneKey']
      source: Map<string, AgentStatusEntry[]>
      byWorktree: Map<string, AgentStatusEntry[]>
      byPane: Map<string, AgentStatusEntry>
    }
  | undefined

function updateUnoccupied(
  state: SleepRowsState & Pick<AppState, 'agentStatusByPaneKey'>
): NonNullable<typeof masked> {
  const byWorktree = sleptAgentEntriesByWorktree(state)
  const live = state.agentStatusByPaneKey
  if (masked?.live === live && masked.source === byWorktree) {
    return masked
  }
  const dirty = new Set<string>()
  if (masked?.source !== byWorktree) {
    for (const [owner, entries] of byWorktree) {
      if (masked?.source.get(owner) !== entries) {
        dirty.add(owner)
      }
    }
    for (const owner of masked?.source.keys() ?? []) {
      if (!byWorktree.has(owner)) {
        dirty.add(owner)
      }
    }
  }
  if (masked?.live !== live) {
    const change = masked ? readRecordChanges(live, masked.live) : null
    const keys =
      change?.kind === 'addressed'
        ? change.keys
        : new Set([...Object.keys(live), ...Object.keys(masked?.live ?? {})])
    for (const key of keys) {
      if (Boolean(live[key]) === Boolean(masked?.live[key])) {
        continue
      }
      const owner = sleptAgentWorktreeForPane(key)
      if (owner) {
        dirty.add(owner)
      }
    }
  }
  let output = masked?.byWorktree ?? new Map<string, AgentStatusEntry[]>()
  let points = masked?.byPane ?? new Map<string, AgentStatusEntry>()
  for (const owner of dirty) {
    const previousRows = output.get(owner) ?? []
    const rows = (byWorktree.get(owner) ?? []).filter((entry) => !live[entry.paneKey])
    if (
      rows.length === previousRows.length &&
      rows.every((entry, i) => entry === previousRows[i])
    ) {
      continue
    }
    if (output === masked?.byWorktree) {
      output = new Map(output)
    }
    if (points === masked?.byPane) {
      points = new Map(points)
    }
    for (const entry of previousRows) {
      points.delete(entry.paneKey)
    }
    for (const entry of rows) {
      points.set(entry.paneKey, entry)
    }
    if (rows.length) {
      output.set(owner, rows)
    } else {
      output.delete(owner)
    }
  }
  masked = { live, source: byWorktree, byWorktree: output, byPane: points }
  return masked
}
export function unoccupiedSleptAgentEntriesByWorktree(
  state: SleepRowsState & Pick<AppState, 'agentStatusByPaneKey'>
): Map<string, AgentStatusEntry[]> {
  return updateUnoccupied(state).byWorktree
}
export function unoccupiedSleptAgentStatusByPaneKey(
  state: SleepRowsState & Pick<AppState, 'agentStatusByPaneKey'>
): ReadonlyMap<string, AgentStatusEntry> {
  return updateUnoccupied(state).byPane
}

import type { AppState } from '@/store/types'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/structured-agent-session-tabs'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getTabIdToWorktreeId } from './workspace-card/activity/worktree-agent-row-selectors'
import {
  worktreeAgentProjectionInputs,
  worktreeAgentStructureInputs
} from './workspace-card/activity/worktree-agent-rows-projection'

export type SlotSnapshot = {
  inputs: readonly unknown[]
  structure: readonly unknown[]
  live: AppState['agentStatusByPaneKey']
  acknowledgements: AppState['acknowledgedAgentsByPaneKey']
  epoch: number
  at: number
}
let current: SlotSnapshot | undefined
export function slotSnapshot(state: AppState): SlotSnapshot {
  const inputs = worktreeAgentProjectionInputs(state)
  if (!current || !inputs.every((value, index) => value === current!.inputs[index])) {
    current = {
      inputs,
      structure: worktreeAgentStructureInputs(state),
      live: state.agentStatusByPaneKey,
      acknowledgements: state.acknowledgedAgentsByPaneKey,
      epoch: state.agentStatusEpoch,
      at: current?.epoch === state.agentStatusEpoch ? current.at : Date.now()
    }
  }
  return current
}
const changes = new WeakMap<SlotSnapshot, WeakMap<SlotSnapshot, Set<string> | null>>()

export function changedSlotWorkspaces(
  state: AppState,
  before: SlotSnapshot,
  after: SlotSnapshot
): Set<string> | null {
  const cached = changes.get(before)?.get(after)
  if (cached !== undefined) {
    return cached
  }
  let result: Set<string> | null = null
  if (after.structure.every((value, index) => value === before.structure[index])) {
    result = new Set<string>()
    const tabOwners = getTabIdToWorktreeId(state.tabsByWorktree)
    const includePane = (paneKey: string): void => {
      const parsed = parsePaneKey(paneKey)
      const tabOwner = parsed && tabOwners.get(parsed.tabId)
      const represented = getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).get(
        paneKey
      )
      if (tabOwner) {
        result!.add(tabOwner)
      }
      // Structured sessions may have no backing terminal tab.
      if (represented) {
        result!.add(represented.worktreeId)
      }
      for (const entry of [
        before.live[paneKey],
        after.live[paneKey],
        state.retainedAgentsByPaneKey[paneKey]?.entry
      ]) {
        if (entry?.worktreeId) {
          result!.add(entry.worktreeId)
        }
      }
    }
    if (before.live !== after.live || before.epoch !== after.epoch) {
      for (const paneKey of new Set([...Object.keys(before.live), ...Object.keys(after.live)])) {
        const previous = before.live[paneKey]
        const next = after.live[paneKey]
        if (
          previous !== next ||
          (next &&
            before.epoch !== after.epoch &&
            isExplicitAgentStatusFresh(next, before.at, AGENT_STATUS_STALE_AFTER_MS) !==
              isExplicitAgentStatusFresh(next, after.at, AGENT_STATUS_STALE_AFTER_MS))
        ) {
          includePane(paneKey)
        }
      }
    }
    if (before.acknowledgements !== after.acknowledgements) {
      for (const paneKey of new Set([
        ...Object.keys(before.acknowledgements),
        ...Object.keys(after.acknowledgements)
      ])) {
        if (before.acknowledgements[paneKey] !== after.acknowledgements[paneKey]) {
          includePane(paneKey)
        }
      }
    }
  }
  let next = changes.get(before)
  if (!next) {
    next = new WeakMap()
    changes.set(before, next)
  }
  next.set(after, result)
  return result
}

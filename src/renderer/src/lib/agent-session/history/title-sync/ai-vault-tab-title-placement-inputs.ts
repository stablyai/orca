import type { AppState } from '@/store/types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { isAiVaultTitleAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'

type TitleFact =
  | NonNullable<ReturnType<AppState['agentStatusByPaneKey']['get']>>
  | AppState['sleepingAgentSessionsByPaneKey'][string]
  | AppState['agentConversationsByPaneKey'][string]

export function titleRelevant(entry: TitleFact | undefined): boolean {
  return Boolean(
    entry &&
    isAiVaultTitleAgent('agent' in entry ? entry.agent : entry.agentType) &&
    entry.providerSession?.id
  )
}

function paneHasTitleFact(state: AppState, key: string): boolean {
  return [
    state.agentStatusByPaneKey.get(key),
    state.sleepingAgentSessionsByPaneKey[key],
    state.agentConversationsByPaneKey?.[key]
  ].some(titleRelevant)
}

export function placedPanesEqual(current: AppState, previous: AppState): boolean {
  const changes = readRecordChanges(current.terminalLayoutsByTabId, previous.terminalLayoutsByTabId)
  const tabs =
    changes?.kind === 'addressed'
      ? changes.keys
      : new Set([
          ...Object.keys(current.terminalLayoutsByTabId),
          ...Object.keys(previous.terminalLayoutsByTabId)
        ])
  const rootless = new Map<string, (leaf: string) => boolean>()
  for (const tab of tabs) {
    const beforeRoot = previous.terminalLayoutsByTabId[tab]?.root
    const afterRoot = current.terminalLayoutsByTabId[tab]?.root
    if (beforeRoot === afterRoot) {
      continue
    }
    const before = beforeRoot ? new Set(collectLayoutLeafIdsInOrder(beforeRoot)) : null
    const after = afterRoot ? new Set(collectLayoutLeafIdsInOrder(afterRoot)) : null
    const membershipChanged = (leaf: string): boolean =>
      (before?.has(leaf) ?? true) !== (after?.has(leaf) ?? true)
    if (before && after) {
      for (const leaf of new Set([...before, ...after])) {
        const key = `${tab}:${leaf}`
        if (
          membershipChanged(leaf) &&
          (paneHasTitleFact(current, key) || paneHasTitleFact(previous, key))
        ) {
          return false
        }
      }
    } else {
      rootless.set(tab, membershipChanged)
    }
  }
  // Rootless layouts accept any leaf; compare their boundaries in one source pass.
  if (rootless.size > 0) {
    for (const state of [previous, current]) {
      for (const record of [
        state.agentStatusByPaneKey,
        state.sleepingAgentSessionsByPaneKey,
        state.agentConversationsByPaneKey ?? {}
      ]) {
        for (const entry of record === state.agentStatusByPaneKey
          ? state.agentStatusByPaneKey.values()
          : Object.values(record)) {
          if (!titleRelevant(entry)) {
            continue
          }
          const pane = parsePaneKey(entry.paneKey)
          if (pane && rootless.get(pane.tabId)?.(pane.leafId)) {
            return false
          }
        }
      }
    }
  }
  return true
}

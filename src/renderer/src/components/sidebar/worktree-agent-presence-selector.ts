import type { AppState } from '@/store/types'
import type { AgentPresenceByPaneKey, AgentPresenceRecord } from '@/store/slices/agent-presence'
import { createWorktreeRecordSelector } from '@/store/worktree-record-selector-cache'
import { getTabIdToWorktreeId } from './worktree-agent-row-selectors'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type PresenceState = Pick<AppState, 'tabsByWorktree'> &
  Partial<Pick<AppState, 'agentPresenceByPaneKey'>>
export const EMPTY_AGENT_PRESENCE: AgentPresenceByPaneKey = Object.freeze({})
let indexedPresence: AgentPresenceByPaneKey | undefined
let indexedTabs: AppState['tabsByWorktree'] | undefined
let byWorktree = new Map<string, Record<string, AgentPresenceRecord>>()

export const selectWorktreeAgentPresence = createWorktreeRecordSelector<
  PresenceState,
  AgentPresenceByPaneKey
>({
  readSources: (state) => [state.tabsByWorktree, state.agentPresenceByPaneKey],
  empty: EMPTY_AGENT_PRESENCE,
  build: (state, worktreeId) => {
    if (indexedPresence !== state.agentPresenceByPaneKey || indexedTabs !== state.tabsByWorktree) {
      const tabs = getTabIdToWorktreeId(state.tabsByWorktree)
      byWorktree = new Map()
      for (const [paneKey, record] of Object.entries(state.agentPresenceByPaneKey ?? {})) {
        const pane = parsePaneKey(paneKey)
        const owner = record.worktreeId ?? (pane ? tabs.get(pane.tabId) : undefined)
        if (!owner) {
          continue
        }
        const bucket = byWorktree.get(owner) ?? {}
        bucket[paneKey] = record
        byWorktree.set(owner, bucket)
      }
      indexedPresence = state.agentPresenceByPaneKey
      indexedTabs = state.tabsByWorktree
    }
    return byWorktree.get(worktreeId) ?? EMPTY_AGENT_PRESENCE
  }
})

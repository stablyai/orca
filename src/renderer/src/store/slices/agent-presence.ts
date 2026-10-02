import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../../shared/agent-process-presence'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import { publishAgentPresence } from '@/lib/agent-presence-transitions'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AgentStatusSlice } from './agent-status-slice-contract'

export type AgentPresenceRecord = {
  presence: AgentProcessPresence
  receivedAt: number
  connectionId?: string | null
  worktreeId?: string
}

export type AgentPresenceByPaneKey = Readonly<Record<string, AgentPresenceRecord>>

/** Every owner-carrying hook republishes the same owner; only a changed one is news. */
function samePresenceRecord(previous: AgentPresenceRecord, next: AgentPresenceRecord): boolean {
  const a = previous.presence
  const b = next.presence
  return (
    a.agent === b.agent &&
    a.ended === b.ended &&
    (a.process && b.process ? isSameAgentProcess(a.process, b.process) : a.process === b.process) &&
    previous.connectionId === next.connectionId &&
    previous.worktreeId === next.worktreeId
  )
}

export function createAgentPresenceActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  'recordAgentPresence' | 'releaseAgentPresence' | 'retireEndedAgentPresence'
> {
  const dropRecord = (paneKey: string): void => {
    runtime.set((state) => ({
      agentPresenceByPaneKey: removePaneKeys(state.agentPresenceByPaneKey, new Set([paneKey])),
      agentStatusEpoch: state.agentStatusEpoch + 1,
      sortEpoch: state.sortEpoch + 1
    }))
    runtime.runAfterCommit(() => publishAgentPresence(paneKey, undefined))
  }
  return {
    recordAgentPresence: (paneKey, record) => {
      const previous = runtime.get().agentPresenceByPaneKey[paneKey]
      if (
        previous &&
        (samePresenceRecord(previous, record) ||
          (previous.connectionId === record.connectionId &&
            previous.receivedAt > record.receivedAt))
      ) {
        return
      }
      runtime.set((state) => {
        return {
          agentPresenceByPaneKey: { ...state.agentPresenceByPaneKey, [paneKey]: record },
          agentStatusEpoch: state.agentStatusEpoch + 1,
          sortEpoch: state.sortEpoch + 1
        }
      })
      const ended = Boolean(record.presence.process && record.presence.ended)
      runtime.runAfterCommit(() => {
        const state = runtime.get()
        if (state.agentPresenceByPaneKey[paneKey] !== record) {
          return
        }
        if (ended) {
          state.setCacheTimerStartedAt(paneKey, null)
          // Why: a proven exit is what a confirmed shell return proves, so its row goes the same way.
          if (state.agentStatusByPaneKey[paneKey]?.agentType === record.presence.agent) {
            state.dropAgentStatus(paneKey)
          }
        }
        publishAgentPresence(paneKey, record.presence)
      })
    },
    retireEndedAgentPresence: (paneKey) => {
      const presence = runtime.get().agentPresenceByPaneKey[paneKey]?.presence
      if (presence?.process && presence.ended) {
        dropRecord(paneKey)
      }
    },
    releaseAgentPresence: (paneKey, process) => {
      const current = runtime.get().agentPresenceByPaneKey[paneKey]?.presence.process
      // Why: a release names one process, so it can never drop a replacement's record.
      if (!current || !isSameAgentProcess(current, process)) {
        return
      }
      dropRecord(paneKey)
    }
  }
}

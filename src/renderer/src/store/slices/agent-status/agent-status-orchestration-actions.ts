import {
  canonicalOrchestrationForRow,
  recordOrchestrationProducer,
  orchestrationProducer
} from '@/runtime/visible-agent-orchestration'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../../shared/agent-status-types'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import {
  getAgentRowGeneratedTitleText,
  orchestrationLabelsMatchLiveDispatch
} from '../../../../../shared/agent-row-primary-text'
import {
  mergeCurrentOrchestrationContext,
  orchestrationContextsEqual
} from './agent-status-orchestration-context'

export function createAgentStatusOrchestrationActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'setRuntimeAgentOrchestrationByPaneKey'> {
  const { get, set } = runtime
  return {
    setRuntimeAgentOrchestrationByPaneKey: (
      entries: Record<string, AgentStatusOrchestrationContext>,
      producerHost = LOCAL_EXECUTION_HOST_ID
    ) => {
      const generatedTitleUpdates: AgentStatusEntry[] = []
      set((s, changedPaneKeys) => {
        const previous = s.runtimeAgentOrchestrationByPaneKey
        const reconciled: Record<string, AgentStatusOrchestrationContext> = Object.fromEntries([])
        let runtimeMapChanged = Object.keys(previous).length !== Object.keys(entries).length
        for (const [key, context] of Object.entries(entries)) {
          const old = previous[key]
          const value =
            old &&
            orchestrationProducer(old) === producerHost &&
            orchestrationContextsEqual(old, context)
              ? old
              : context
          reconciled[key] = value
          recordOrchestrationProducer(value, producerHost)
          if (value !== old) {
            runtimeMapChanged = true
          }
        }
        const canonicalState = {
          ...s,
          runtimeAgentOrchestrationByPaneKey: runtimeMapChanged ? reconciled : previous
        }
        let nextLive = s.agentStatusByPaneKey
        let liveChanged = false
        let nextRetained = s.retainedAgentsByPaneKey
        let retainedChanged = false

        for (const paneKey of new Set([...Object.keys(nextLive), ...Object.keys(nextRetained)])) {
          const runtimeOrchestration = canonicalOrchestrationForRow(canonicalState, paneKey)
          if (!runtimeOrchestration) {
            continue
          }
          const liveEntry = nextLive[paneKey]
          if (liveEntry) {
            const merged = mergeCurrentOrchestrationContext(
              liveEntry.orchestration,
              runtimeOrchestration
            )
            if (merged !== liveEntry.orchestration) {
              if (!liveChanged) {
                nextLive = { ...nextLive }
                liveChanged = true
              }
              const nextEntry = { ...liveEntry, orchestration: merged }
              changedPaneKeys.add(paneKey)
              nextLive[paneKey] = nextEntry
              // Why: only replace titles when labels match the live dispatch taskId; sticky completed context must not rename a later turn.
              if (
                (merged.displayName?.trim() || merged.taskTitle?.trim()) &&
                orchestrationLabelsMatchLiveDispatch({
                  prompt: nextEntry.prompt,
                  orchestration: merged
                })
              ) {
                generatedTitleUpdates.push(nextEntry)
              }
            }
          }

          const retainedEntry = nextRetained[paneKey]
          if (retainedEntry) {
            const merged = mergeCurrentOrchestrationContext(
              retainedEntry.entry.orchestration,
              runtimeOrchestration
            )
            if (merged !== retainedEntry.entry.orchestration) {
              if (!retainedChanged) {
                nextRetained = { ...nextRetained }
                retainedChanged = true
              }
              nextRetained[paneKey] = {
                ...retainedEntry,
                entry: { ...retainedEntry.entry, orchestration: merged }
              }
            }
          }
        }

        if (!runtimeMapChanged && !liveChanged && !retainedChanged) {
          return s
        }

        return {
          ...(runtimeMapChanged ? { runtimeAgentOrchestrationByPaneKey: reconciled } : {}),
          ...(liveChanged ? { agentStatusByPaneKey: nextLive } : {}),
          ...(retainedChanged ? { retainedAgentsByPaneKey: nextRetained } : {}),
          ...(liveChanged ? { agentStatusEpoch: s.agentStatusEpoch + 1 } : {})
        }
      })
      for (const entry of generatedTitleUpdates) {
        get().setGeneratedTabTitleFromAgentPrompt(
          entry.paneKey,
          getAgentRowGeneratedTitleText(entry),
          {
            replaceExistingGeneratedTitle: true
          }
        )
      }
    }
  }
}

import {
  canonicalOrchestrationForRow,
  recordOrchestrationProducer,
  orchestrationProducer
} from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusSlice } from '../contracts/agent-status-slice-contract'
import type { AgentStatusRuntime } from '../status-ownership/agent-status-runtime'
import {
  getAgentRowGeneratedTitleText,
  orchestrationLabelsMatchLiveDispatch
} from '../../../../../../shared/agent-status/presentation/agent-row-primary-text'
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
        let runtimeMapChanged = false
        // Each host replaces only its own contexts: a local graph reply must not drop a remote host's lineage.
        for (const [key, old] of Object.entries(previous)) {
          if (!(key in entries) && orchestrationProducer(old) !== producerHost) {
            reconciled[key] = old
          } else if (!(key in entries)) {
            runtimeMapChanged = true
          }
        }
        for (const [key, context] of Object.entries(entries)) {
          const old = previous[key]
          // A re-sent held map passes the very objects stored, which keep the host that produced them.
          const value =
            old &&
            (old === context ||
              (orchestrationProducer(old) === producerHost &&
                orchestrationContextsEqual(old, context)))
              ? old
              : context
          reconciled[key] = value
          if (value !== old) {
            recordOrchestrationProducer(value, producerHost)
            runtimeMapChanged = true
          }
        }
        const canonicalState = {
          ...s,
          runtimeAgentOrchestrationByPaneKey: runtimeMapChanged ? reconciled : previous
        }
        let nextLive = s.agentStatusByPaneKey
        let liveChanged = false

        for (const paneKey of Array.from(nextLive.keys())) {
          const runtimeOrchestration = canonicalOrchestrationForRow(canonicalState, paneKey)
          if (!runtimeOrchestration) {
            continue
          }
          const liveEntry = nextLive.get(paneKey)
          if (liveEntry) {
            const merged = mergeCurrentOrchestrationContext(
              liveEntry.orchestration,
              runtimeOrchestration
            )
            if (merged !== liveEntry.orchestration) {
              liveChanged = true
              const nextEntry = { ...liveEntry, orchestration: merged }
              changedPaneKeys.add(paneKey)
              nextLive = nextLive.replace([[paneKey, nextEntry]])
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
        }

        if (!runtimeMapChanged && !liveChanged) {
          return s
        }

        return {
          ...(runtimeMapChanged ? { runtimeAgentOrchestrationByPaneKey: reconciled } : {}),
          ...(liveChanged ? { agentStatusByPaneKey: nextLive } : {}),
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

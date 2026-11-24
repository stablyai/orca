import { recordWorkerTabFeed } from '@/components/tab-bar/worker-tab-feed-grace'
import { linkRecordWrite } from '@/store/record-transitions/keyed-record-transitions'
import {
  canonicalOrchestrationForRow,
  recordOrchestrationProducer,
  orchestrationProducer
} from '@/runtime/agent-orchestration/visible-agent-orchestration'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
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
        const previousKeys = Object.keys(previous)
        let runtimeMapChanged = previousKeys.length !== Object.keys(entries).length
        let sameOrder = !runtimeMapChanged
        let position = 0
        let replacedRuntimeKeys: string[] | undefined
        for (const [key, context] of Object.entries(entries)) {
          sameOrder &&= previousKeys[position++] === key
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
            ;(replacedRuntimeKeys ??= []).push(key)
          }
        }
        if (runtimeMapChanged && sameOrder && replacedRuntimeKeys) {
          linkRecordWrite(reconciled, previous, replacedRuntimeKeys)
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
      // The first projection, empty included, ends the restored-worker fold grace.
      recordWorkerTabFeed(producerHost, 'orchestration')
      if (producerHost === LOCAL_EXECUTION_HOST_ID) {
        for (const [targetId, connection] of get().sshConnectionStates ?? []) {
          if (connection.status === 'connected') {
            recordWorkerTabFeed(toSshExecutionHostId(targetId), 'orchestration')
          }
        }
      }
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

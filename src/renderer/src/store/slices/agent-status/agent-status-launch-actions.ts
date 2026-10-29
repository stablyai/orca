import { editSessionSource } from '@/store/session-source-edits'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AgentLaunchConfigRegistryEntry } from './agent-status-contract'
import { copyLaunchConfig } from '../../../../../shared/agent-resume-record-from-status'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'
import {
  getLaunchConfigForEntry,
  launchConfigRegistryEntriesEqual,
  normalizeLaunchConfigRegistrationMetadata,
  registryEntryMatchesStatus
} from './agent-status-launch-config'
import { findAgentPaneWorktreeId, getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'

export function createAgentStatusLaunchActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  'registerAgentLaunchConfig' | 'getAgentLaunchConfigForStatusEntry' | 'clearAgentLaunchConfig'
> {
  const { get, set } = runtime
  return {
    registerAgentLaunchConfig: (paneKey, launchConfig, metadata) => {
      set((s) => {
        const copiedLaunchConfig = copyLaunchConfig(launchConfig)
        const nextRegistryEntry: AgentLaunchConfigRegistryEntry = {
          launchConfig: copiedLaunchConfig,
          registeredAt: Date.now(),
          identity: normalizeLaunchConfigRegistrationMetadata(paneKey, metadata)
        }
        const existingRegistryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const registryChanged = !launchConfigRegistryEntriesEqual(
          existingRegistryEntry,
          nextRegistryEntry
        )
        const existingEntry = s.agentStatusByPaneKey[paneKey]
        const entryMatchesRegistry = registryEntryMatchesStatus({
          entry: nextRegistryEntry,
          paneKey,
          agentType: existingEntry?.agentType,
          tabId: existingEntry?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined,
          terminalHandle: existingEntry?.terminalHandle,
          launchToken: metadata?.launchToken,
          providerSession: existingEntry?.providerSession,
          existingProviderSession: existingEntry?.providerSession,
          providerSessionChanged: false
        })
        const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        const edit = editSessionSource(s)
        if (existingSleepingRecord && entryMatchesRegistry && existingEntry) {
          const worktreeId =
            existingEntry.worktreeId ??
            existingSleepingRecord.worktreeId ??
            findAgentPaneWorktreeId(s, paneKey)
          const refreshedRecord = worktreeId
            ? sleepingRecordFromEntry({
                state: s,
                entry: existingEntry,
                worktreeId,
                capturedAt: existingSleepingRecord.capturedAt,
                launchConfig: copiedLaunchConfig,
                origin: existingSleepingRecord.origin
              })
            : null
          if (refreshedRecord) {
            edit.set('sleepingAgentSessionsByPaneKey', paneKey, {
              ...refreshedRecord,
              capturedAt: existingSleepingRecord.capturedAt
            })
          }
        }
        if (!registryChanged && !edit.changed) {
          return undefined
        }
        return edit.finish(
          registryChanged
            ? {
                agentLaunchConfigByPaneKey: {
                  ...s.agentLaunchConfigByPaneKey,
                  [paneKey]: nextRegistryEntry
                }
              }
            : {}
        )
      })
    },
    getAgentLaunchConfigForStatusEntry: (entry) => getLaunchConfigForEntry(get(), entry),
    clearAgentLaunchConfig: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.agentLaunchConfigByPaneKey)) {
          return undefined
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        delete nextLaunchConfigs[paneKey]
        return { agentLaunchConfigByPaneKey: nextLaunchConfigs }
      })
    }
  }
}

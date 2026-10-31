import { useCallback, useMemo } from 'react'
import {
  useAgentMessageSenderSource,
  type SenderLocation
} from './native-chat-agent-message-sender-source'
import type { AppState } from '@/store/types'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { structuredAgentSessionOwnerInputs } from '@/runtime/structured-agent-session-owner'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  agentMessageSenderOwner,
  findAgentMessageSenderChatTab
} from './native-chat-agent-message-sender-label'

const handleIndexes = new WeakMap<
  object,
  { inputs: unknown[]; index: Map<string, Map<string | null, AgentStatusEntry[]>> }
>()
function byHandle(
  state: AppState,
  source: AppState['agentStatusByPaneKey'] | AppState['retainedAgentsByPaneKey']
) {
  const inputs = structuredAgentSessionOwnerInputs(state)
  let cached = handleIndexes.get(source)
  if (!cached || inputs.some((value, index) => value !== cached?.inputs[index])) {
    const index = new Map<string, Map<string | null, AgentStatusEntry[]>>()
    const owners = new Map<string, string | null>()
    for (const value of Object.values(source)) {
      const entry = 'entry' in value ? value.entry : value
      if (!entry.terminalHandle || !entry.worktreeId) {
        continue
      }
      if (!owners.has(entry.worktreeId)) {
        owners.set(entry.worktreeId, getKnownExecutionHostIdForWorktree(state, entry.worktreeId))
      }
      const owner = owners.get(entry.worktreeId) ?? null
      let byHost = index.get(entry.terminalHandle)
      if (!byHost) {
        byHost = new Map()
        index.set(entry.terminalHandle, byHost)
      }
      const entries = byHost.get(owner) ?? []
      entries.push(entry)
      byHost.set(owner, entries)
    }
    cached = { inputs, index }
    handleIndexes.set(source, cached)
  }
  return cached.index
}

export function useAgentMessageSenderView(
  sender: AgentMessageSender | undefined,
  chatWorktreeId: string | null,
  target?: RuntimeClientTarget
) {
  const address = sender?.party.address
  const sessionId = sender?.party.orcaSessionId
  const handle = sender?.party.terminalHandle
  const targetKind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  const stableTarget = useMemo<RuntimeClientTarget | undefined>(
    () =>
      targetKind === 'local'
        ? { kind: 'local' }
        : environmentId !== undefined
          ? { kind: 'environment', environmentId }
          : undefined,
    [targetKind, environmentId]
  )
  const locate = useCallback(
    (state: AppState): SenderLocation | undefined => {
      if (!address || address.startsWith('dispatch:')) {
        return undefined
      }
      const owner = agentMessageSenderOwner(state, chatWorktreeId, stableTarget)
      if (!owner) {
        return undefined
      }
      const chatTab = sessionId ? findAgentMessageSenderChatTab(state, sessionId, owner) : undefined
      let paneKey = chatTab && structuredAgentSessionPaneKey(chatTab.id, chatTab.entityId)
      if (!paneKey && handle) {
        for (const source of [state.agentStatusByPaneKey, state.retainedAgentsByPaneKey]) {
          const matches = byHandle(state, source).get(handle)?.get(owner) ?? []
          if (matches.length) {
            paneKey = matches.length === 1 ? matches[0].paneKey : undefined
            break
          }
        }
      }
      const worktreeId =
        chatTab?.worktreeId ??
        (paneKey
          ? (state.agentStatusByPaneKey[paneKey]?.worktreeId ??
            state.retainedAgentsByPaneKey[paneKey]?.worktreeId)
          : undefined)
      return worktreeId && paneKey
        ? { host: owner, worktreeId, paneKey, agentType: chatTab?.agentSessionAgent }
        : undefined
    },
    [address, sessionId, handle, chatWorktreeId, stableTarget]
  )
  return useAgentMessageSenderSource(locate)
}

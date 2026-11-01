import { useMemo } from 'react'
import {
  useAgentMessageSenderSource,
  useAgentMessageSenderSources,
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

export type AgentMessageSenderInput = {
  sender: AgentMessageSender | undefined
  worktreeId: string | null
}

function stableRuntimeTarget(
  targetKind: RuntimeClientTarget['kind'] | undefined,
  environmentId: string | undefined
): RuntimeClientTarget | undefined {
  return targetKind === 'local'
    ? { kind: 'local' }
    : environmentId !== undefined
      ? { kind: 'environment', environmentId }
      : undefined
}

function senderLocator(
  address: string | undefined,
  sessionId: string | null | undefined,
  handle: string | null | undefined,
  chatWorktreeId: string | null,
  target: RuntimeClientTarget | undefined
): (state: AppState) => SenderLocation | undefined {
  return (state) => {
    if (!address || address.startsWith('dispatch:')) {
      return undefined
    }
    const owner = agentMessageSenderOwner(state, chatWorktreeId, target)
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
  }
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
  const locate = useMemo(
    () =>
      senderLocator(
        address,
        sessionId,
        handle,
        chatWorktreeId,
        stableRuntimeTarget(targetKind, environmentId)
      ),
    [address, sessionId, handle, chatWorktreeId, targetKind, environmentId]
  )
  return useAgentMessageSenderSource(locate)
}

/** List form of the card avatar's view: one subscription for every sender in `inputs`. */
export function useAgentMessageSenderViews(
  inputs: readonly AgentMessageSenderInput[],
  target?: RuntimeClientTarget
) {
  const targetKind = target?.kind
  const environmentId = target?.kind === 'environment' ? target.environmentId : undefined
  const locates = useMemo(() => {
    const stable = stableRuntimeTarget(targetKind, environmentId)
    return inputs.map(({ sender, worktreeId }) =>
      senderLocator(
        sender?.party.address,
        sender?.party.orcaSessionId,
        sender?.party.terminalHandle,
        worktreeId,
        stable
      )
    )
  }, [inputs, targetKind, environmentId])
  return useAgentMessageSenderSources(locates)
}

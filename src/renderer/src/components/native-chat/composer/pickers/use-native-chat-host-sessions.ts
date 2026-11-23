import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/files/access/file-owner-runtime-target'
import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import { findBotByWorkspace } from '@/components/bots/bot-workspace'
import { chatWorkspaceByTabId as findTerminalTabWorktreeId } from '../../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import type { AgentListResult } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalListResult } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  rankNativeChatCrewMentions,
  type CrewAgentMentions
} from '../../../orchestration-crew/native-chat-crew-mentions'
import {
  hostSessionMentions,
  NO_HOST_SESSION_MENTIONS,
  type HostSessionLists,
  type HostSessionSelf
} from './native-chat-host-session-mentions'

const LIST_TIMEOUT_MS = 5_000
const NO_VALUES: readonly string[] = []

/** The host's other chats and terminals for `@` (`query` non-null while open), read once each
 *  time it opens; without `self`, none. `references` also holds the crew agents', so one lookup
 *  finds any picked chip. */
export function useNativeChatHostSessions(
  query: string | null,
  self: HostSessionSelf | undefined,
  crew: CrewAgentMentions,
  { terminalTabId, structuredWorktreeId }: { terminalTabId: string; structuredWorktreeId?: string }
) {
  const paneKey = self?.paneKey
  const sessionId = self?.sessionId
  const ptyId = self?.ptyId ?? null
  const open = query !== null && paneKey !== undefined
  const [lists, setLists] = useState<HostSessionLists | null>(null)
  useEffect(() => {
    setLists(null)
    if (!open) {
      return
    }
    const state = useAppStore.getState()
    const target = getRuntimeTargetForWorktreeOwner(
      state,
      structuredWorktreeId ?? findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
    )
    if (!target) {
      return
    }
    const hostId = getRuntimeTargetHostId(target)
    let live = true
    void Promise.allSettled([
      callRuntimeRpc<AgentListResult>(target, 'agent.list', {}, { timeoutMs: LIST_TIMEOUT_MS }),
      callRuntimeRpc<RuntimeTerminalListResult>(
        target,
        'terminal.list',
        { includeVisualLayouts: false, includePreview: false },
        { timeoutMs: LIST_TIMEOUT_MS }
      )
    ]).then(([agents, terminals]) => {
      if (!live) {
        return
      }
      // With bots off a bot's home is a plain folder.
      const bots = readBotsEnabled() ? readBots() : []
      setLists({
        hostKey: target.kind === 'local' ? 'local' : target.environmentId,
        agents: agents.status === 'fulfilled' ? agents.value.agents : [],
        terminals: terminals.status === 'fulfilled' ? terminals.value.terminals : [],
        isBotHome: (worktreeId) => findBotByWorkspace(bots, worktreeId, hostId) !== null
      })
    })
    return () => {
      live = false
    }
  }, [open, structuredWorktreeId, terminalTabId])
  const mentions = useMemo(() => {
    const listed = new Set([...crew.references.values()].map((agent) => agent.address))
    return lists && paneKey !== undefined
      ? hostSessionMentions(lists, { paneKey, sessionId, ptyId }, listed)
      : NO_HOST_SESSION_MENTIONS
  }, [lists, paneKey, sessionId, ptyId, crew])
  return useMemo(
    () => ({
      chats: mentions.chats,
      terminals: mentions.terminals,
      references: new Map([...crew.references, ...mentions.references]),
      values:
        query === null
          ? NO_VALUES
          : [
              ...rankNativeChatCrewMentions(mentions.chats, query),
              ...rankNativeChatCrewMentions(mentions.terminals, query)
            ]
    }),
    [mentions, crew, query]
  )
}

import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/files/access/file-owner-runtime-target'
import { chatWorkspaceByTabId as findTerminalTabWorktreeId } from '../../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import type { AgentListResult } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalListResult } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  hostSessionMentions,
  NO_HOST_SESSION_MENTIONS,
  type HostSessionMentions,
  type HostSessionSelf
} from './native-chat-host-session-mentions'

const LIST_TIMEOUT_MS = 5_000

/** The other chats and terminals of the composer's host, read once each time `@` opens; `self`
 *  absent lists none. A list that fails leaves out its kind only. */
export function useNativeChatHostSessionMentions(args: {
  open: boolean
  self: HostSessionSelf | undefined
  terminalTabId: string
  structuredWorktreeId: string | undefined
}): HostSessionMentions {
  const { open, self, terminalTabId, structuredWorktreeId } = args
  const sessionId = self?.sessionId
  const ptyId = self?.ptyId
  const listed = self !== undefined
  const [mentions, setMentions] = useState(NO_HOST_SESSION_MENTIONS)
  useEffect(() => {
    setMentions(NO_HOST_SESSION_MENTIONS)
    if (!open || !listed) {
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
    const hostKey = target.kind === 'local' ? 'local' : target.environmentId
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
      if (live) {
        setMentions(
          hostSessionMentions(
            agents.status === 'fulfilled' ? agents.value.agents : [],
            terminals.status === 'fulfilled' ? terminals.value.terminals : [],
            hostKey,
            { sessionId, ptyId }
          )
        )
      }
    })
    return () => {
      live = false
    }
  }, [open, listed, sessionId, ptyId, structuredWorktreeId, terminalTabId])
  return mentions
}

import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/files/access/file-owner-runtime-target'
import { readBots, readBotsEnabled } from '@/lib/bot-catalog'
import { findBotByWorkspace } from '@/components/bots/bot-workspace'
import { chatWorkspaceByTabId as findTerminalTabWorktreeId } from '../../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import type { AgentListResult } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalListResult } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { HostSessionLists } from './native-chat-host-session-mentions'

const LIST_TIMEOUT_MS = 5_000

/** The chats and terminals of the composer's host, read once each time `@` opens; null while
 *  closed or not read yet. A list that fails leaves out its kind only. */
export function useNativeChatHostSessionLists(args: {
  open: boolean
  terminalTabId: string
  structuredWorktreeId: string | undefined
}): HostSessionLists | null {
  const { open, terminalTabId, structuredWorktreeId } = args
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
  return lists
}

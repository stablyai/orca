import type React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStateView } from '@/store/retained-views/app-state-view'
import { readRuntimeStatusesForView } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  customChatAgents,
  useHostStructuredAgentsVersion
} from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { launchCustomAgentChat } from '@/lib/agent-session/launch/new-tab/launch-custom-agent-chat'
import { AgentLetterIcon } from '../icons/agent-icon-glyphs'
import type { NewTabAgentMenuModel } from './new-tab-agent-menu-model'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'

/** A chat with each of the host's own ACP agents, after the built-in ones; they have no CLI. */
export function CustomAgentChatMenuItems({
  model,
  worktreeId,
  groupId,
  onFocusChat
}: {
  model: NewTabAgentMenuModel
  worktreeId: string
  groupId?: string
  onFocusChat?: (tabId: string) => void
}): React.JSX.Element | null {
  useHostStructuredAgentsVersion()
  const statuses = readRuntimeStatusesForView(useAppStateView())
  const host = model.state === 'settled' ? model.pickerContext?.executionHostId : undefined
  const executionHostId = parseExecutionHostId(host)?.id
  // Hosts without chats (SSH, unpaired) list no agents, so they offer none of these.
  if (!host || !executionHostId) {
    return null
  }
  return (
    <>
      {customChatAgents(host, statuses).map(({ agent, name }) => (
        <DropdownMenuItem
          key={agent}
          variant="launch"
          onSelect={() => {
            const tabId = launchCustomAgentChat({ agent, worktreeId, groupId, executionHostId })
            if (tabId) {
              onFocusChat?.(tabId)
            }
          }}
        >
          <AgentLetterIcon letter={name.charAt(0).toUpperCase()} size={14} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

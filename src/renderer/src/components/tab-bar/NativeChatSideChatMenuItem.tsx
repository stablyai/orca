import { agentChatPermissionModes } from '../../../../shared/agent-chat-permission-mode'
import type { SideChatPermission } from '../../../../shared/agent-session-side-chat'
import { AGENT_SESSION_SIDE_CHAT_READ_ONLY_CAPABILITY } from '../../../../shared/agent-session-side-chat'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { CornerDownRight, Eye, GitFork } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import { useNativeChatSideChat } from '../native-chat/use-native-chat-side-chat'
import type { NativeChatTabSession } from './tab-session-history-switch'
import { translate } from '@/i18n/i18n'
import { useMemo } from 'react'
import { toast } from 'sonner'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

export function NativeChatSideChatMenuItem({
  tab,
  nativeChat,
  onComplete
}: {
  tab: { id: string; worktreeId: string }
  nativeChat: NativeChatTabSession
  onComplete?: () => void
}) {
  const host = useAppStore((state) => {
    const source = state.unifiedTabsByWorktree[tab.worktreeId]?.find((entry) => entry.id === tab.id)
    return source ? structuredAgentSessionOwnerForTab(state, source) : null
  })
  const target = useMemo(() => structuredAgentSessionTargetForHost(host), [host])
  return target ? (
    <SideChatItem target={target} tab={tab} nativeChat={nativeChat} onComplete={onComplete} />
  ) : null
}

function SideChatItem({
  target,
  tab,
  nativeChat,
  onComplete
}: Parameters<typeof NativeChatSideChatMenuItem>[0] & {
  target: NonNullable<ReturnType<typeof structuredAgentSessionTargetForTab>>
}) {
  const open = useNativeChatSideChat({
    target,
    agent: nativeChat.agent ?? '',
    sessionId: nativeChat.sessionId,
    tabId: tab.id,
    worktreeId: tab.worktreeId
  })
  const readOnlySupported = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SIDE_CHAT_READ_ONLY_CAPABILITY
  )
  const reportFailure = () =>
    toast.error(translate('components.native-chat.sideChat.failed', 'Could not open a side chat.'))
  const choose = (permission: SideChatPermission) => {
    onComplete?.()
    void open?.('', [], permission)
      .then((accepted) => {
        if (!accepted) {
          reportFailure()
        }
      })
      .catch(reportFailure)
  }
  return open ? (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CornerDownRight />
        {translate('components.native-chat.sideChat.new', 'New side chat')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem
          disabled={
            !readOnlySupported ||
            !agentChatPermissionModes(nativeChat.agent ?? '')?.modes.includes('read-only')
          }
          onSelect={() => choose('read-only')}
        >
          <Eye />
          {translate('components.native-chat.composer.permissionReadOnly', 'Read only')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => choose('inherit')}>
          <GitFork />
          {translate(
            'components.native-chat.sideChat.inheritPermissions',
            'Use main chat permissions'
          )}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  ) : null
}

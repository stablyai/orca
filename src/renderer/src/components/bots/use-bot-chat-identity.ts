import { useMemo } from 'react'
import { isListedBotHost } from '@/lib/bot-hosts'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { useBotAvatarLook } from './bot-avatar-image'
import type { BotOutfitArt } from './bot-mascot-look'
import { botFallback } from '../../../../shared/bots/bot-avatar-fallback'
import { useNativeChatTabOwnerWorktreeId } from '../native-chat/pane/ownership/use-native-chat-tab-owner'
import type { NativeChatStructuredViewProps } from '../native-chat/native-chat-view-types'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { botOwnsChatSession } from '../../../../shared/bots/bot-chat-identity'
import { selectFolderWorkspaceOnHost } from '../../store/folder-workspaces/folder-workspace-record-index'
import { botHomeHostId } from '../../../../shared/bots/bot-home-host'

export type BotChatIdentity = {
  showName?: boolean
  name: string
  src: string | null
  /** The outfit's art, drawn over `src`. */
  outfit?: BotOutfitArt | null
  fallback: string
}

// Reads nothing: no upload to load.
const NO_BOT_AVATAR: Parameters<typeof useBotAvatarLook>[0] = {
  id: '',
  hostId: LOCAL_EXECUTION_HOST_ID,
  avatar: null
}

/** The bot whose chat this is, from the catalog of the host that owns the session. */
export function useBotChatIdentity(
  workspaceId: string | null,
  sessionId: string | null,
  target: RuntimeClientTarget
) {
  const enabled = useBotsEnabled()
  const scope = parseWorkspaceKey(workspaceId ?? '')
  const folderId = scope?.type === 'folder' ? scope.folderWorkspaceId : null
  const hostId = getRuntimeTargetHostId(target)
  const listed = isListedBotHost(hostId)
  const workspace = useAppStore((state) =>
    listed && folderId
      ? selectFolderWorkspaceOnHost(state, folderId, botHomeHostId({ hostId }))
      : undefined
  )
  const bots = useBots(enabled && workspace !== undefined)
  return (
    bots.find(
      (bot) =>
        bot.hostId === hostId &&
        bot.folderWorkspaceId === workspace?.id &&
        botOwnsChatSession(bot, sessionId, workspace.externalConversations)
    ) ?? null
  )
}

export function useBotChatOwner(
  props: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'target'>
) {
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(props.tabId)
  const turnBot = useBotChatIdentity(ownerWorktreeId, props.sessionId, props.target)
  const { src, outfit } = useBotAvatarLook(turnBot ?? NO_BOT_AVATAR)
  // Keyed on what it shows, not the Bot object: a re-read bot is a new object, and a new identity here
  // would re-render every mounted row of the chat.
  const name = turnBot?.name ?? null
  const fallback = turnBot ? botFallback(turnBot) : null
  const identity = useMemo<BotChatIdentity | null>(
    () => (name !== null && fallback !== null ? { name, src, outfit, fallback } : null),
    [name, src, outfit, fallback]
  )
  return { ownerWorktreeId, turnBot: identity, bot: turnBot }
}

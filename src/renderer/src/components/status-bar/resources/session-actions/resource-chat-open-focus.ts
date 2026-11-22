import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { readBotGroups } from '@/lib/bot-group-catalog-snapshot'
import { botGroupRoomOfRow } from '@/lib/bot-group-room-history'
import { useAppStore } from '../../../../store/index'
import { selectFrontTab } from '../../../../store/slices/tabs/active-tab-selection'
import { focusResourceManagerTrigger } from '../popover/resource-usage-status-trigger'

/**
 * Where focus goes once a chat row's open settles, if nothing took it. Reselecting an already-shown
 * chat or room moves no focus, so its composer takes it; any other tab in front means the open
 * failed, so the trigger takes focus back.
 */
export function settleChatOpenFocus(worktreeId: string, agentSessionId: string): void {
  if (document.activeElement && document.activeElement !== document.body) {
    return
  }
  const tab = selectFrontTab(useAppStore.getState())
  const room = isBotGroupMemberSession(agentSessionId)
    ? botGroupRoomOfRow(readBotGroups(), {
        structuredSession: { workspaceId: worktreeId, sessionId: agentSessionId }
      })
    : null
  const opened =
    tab?.contentType === 'agent-session'
      ? tab.entityId === agentSessionId
      : tab?.contentType === 'room' && tab.entityId === room?.roomId
  if (tab && opened) {
    requestNativeChatComposerFocus(tab.id)
  } else {
    focusResourceManagerTrigger()
  }
}

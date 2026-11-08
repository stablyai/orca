import { PanelBottomClose, PanelRightClose } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'
import type { NativeChatSplitDirection } from '@/components/native-chat/pane/routing/native-chat-pane-shortcut'

function availability(ctx: CmdJQuickActionContext) {
  return ctx.canSplitActiveChat
    ? ({ available: true } as const)
    : ({ available: false, reason: 'no-active-chat' } as const)
}

function splitAction(
  direction: NativeChatSplitDirection,
  action: Pick<CmdJQuickAction, 'id' | 'title' | 'description' | 'icon' | 'verbKeywords'>
): CmdJQuickAction {
  return {
    ...action,
    kind: 'action',
    isAvailable: availability,
    run: async (ctx) => {
      if (!availability(ctx).available || !ctx.splitActiveChat?.(direction)) {
        return { status: 'unavailable', reason: 'no-active-chat' }
      }
      return { status: 'ok' }
    }
  }
}

export function getNativeChatSplitQuickActions(): CmdJQuickAction[] {
  const right = translate('components.native-chat.splitRight', 'Split Right')
  const down = translate('components.native-chat.splitDown', 'Split Down')
  return [
    splitAction('right', {
      id: 'split-chat-right',
      title: right,
      description: right,
      icon: PanelRightClose,
      verbKeywords: [
        right,
        translate('auto.components.cmd.j.quick.actions.verbs.splitChatRight', 'split chat right'),
        translate('auto.components.cmd.j.quick.actions.splitChatRight', 'Split Chat Right'),
        translate('auto.components.cmd.j.quick.actions.verbs.chatPaneRight', 'chat pane right')
      ]
    }),
    splitAction('down', {
      id: 'split-chat-down',
      title: down,
      description: down,
      icon: PanelBottomClose,
      verbKeywords: [
        down,
        translate('auto.components.cmd.j.quick.actions.verbs.splitChatDown', 'split chat down'),
        translate('auto.components.cmd.j.quick.actions.splitChatDown', 'Split Chat Down'),
        translate('auto.components.cmd.j.quick.actions.verbs.chatPaneBelow', 'chat pane below')
      ]
    })
  ]
}

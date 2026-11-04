import { PanelBottomClose, PanelRightClose } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionContext } from './quick-action-context'
import type { NativeChatSplitDirection } from '@/components/native-chat/native-chat-split-shortcut'

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
  const right = translate(
    'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
    'Split Terminal Right'
  )
  const down = translate(
    'auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2',
    'Split Terminal Down'
  )
  return [
    splitAction('right', {
      id: 'split-chat-right',
      title: right,
      description: right,
      icon: PanelRightClose,
      verbKeywords: [right]
    }),
    splitAction('down', {
      id: 'split-chat-down',
      title: down,
      description: down,
      icon: PanelBottomClose,
      verbKeywords: [down]
    })
  ]
}

import { Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'

export function getTerminalCopyModeQuickAction(): CmdJQuickAction {
  return {
    id: 'enter-terminal-copy-mode',
    kind: 'action',
    title: translate('terminal.copyMode.enter', 'Enter Copy Mode'),
    description: translate(
      'terminal.copyMode.description',
      'Select and copy terminal text with the keyboard.'
    ),
    icon: Copy,
    verbKeywords: ['copy mode', 'terminal copy', 'vim', 'tmux'],
    isAvailable: (ctx) =>
      ctx.canEnterCopyMode
        ? { available: true }
        : { available: false, reason: 'no-active-terminal' },
    run: async (ctx) =>
      ctx.enterCopyMode?.()
        ? { status: 'ok' }
        : { status: 'unavailable', reason: 'no-active-terminal' }
  }
}

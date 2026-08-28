import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { copyTerminalHandleForPane } from '../terminal-pane/terminal-handle-copy'
import { resolveTabIdentityLeafId } from './tab-terminal-identifiers'

/** Runtime terminal handle of the tab's focused pane — what agents and the CLI address. */
export async function copyTabTerminalId(tabId: string): Promise<void> {
  try {
    const leafId = resolveTabIdentityLeafId(useAppStore.getState().terminalLayoutsByTabId[tabId])
    if (!leafId) {
      throw new Error('terminal_not_found')
    }
    await copyTerminalHandleForPane({
      tabId,
      leafId,
      callRuntime: window.api.runtime.call,
      writeClipboardText: window.api.ui.writeClipboardText
    })
    toast.success(
      translate(
        'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copied',
        'Terminal ID copied'
      )
    )
  } catch {
    toast.error(
      translate(
        'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copy.failed',
        'Unable to copy terminal ID'
      )
    )
  }
}

export async function copyTabAgentSessionId(sessionId: string): Promise<void> {
  await window.api.ui.writeClipboardText(sessionId)
  toast.success(
    translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
      value0: translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
    })
  )
}

import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { MacOptionAsAlt } from '@/components/terminal-pane/terminal-shortcut-policy'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import { installPreviewTerminalAppMenuClipboard } from './preview-terminal-app-menu-clipboard'
import { installPreviewTerminalCompatibility } from './preview-terminal-compatibility'
import { installPreviewImeBridge, type PreviewImeBridge } from './preview-terminal-ime-bridge'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'
import { createPreviewClipboardPaster } from './preview-terminal-paste'

export function createInteractiveAgentTerminalPreviewController(args: {
  ptyId: string
  container: HTMLElement
  getTerminal: () => Terminal | null
  getTerminalInput: () => DashboardCardTerminalInput | null
  getSettings: () => GlobalSettings | null
  getMacOptionAsAlt: () => MacOptionAsAlt
  getKittyKeyboardFlags: () => number
  getInputEnabled: () => boolean
  isDisposed: () => boolean
  isReplaying: () => boolean
}): { install: () => void; dispose: () => void } {
  let userInputDisposable: { dispose: () => void } | null = null
  let imeBridge: PreviewImeBridge | null = null
  let disposeKeyHandler: (() => void) | null = null
  let disposeTerminalCompatibility: (() => void) | null = null

  const pasteClipboardText = createPreviewClipboardPaster({
    ptyId: args.ptyId,
    container: args.container,
    getTerminal: args.getTerminal,
    getTerminalInput: args.getTerminalInput,
    isInputEnabled: args.getInputEnabled,
    isDisposed: args.isDisposed
  })
  const disposeAppMenuClipboard = installPreviewTerminalAppMenuClipboard({
    container: args.container,
    getTerminal: args.getTerminal,
    pasteClipboardText
  })

  return {
    install: () => {
      const terminal = args.getTerminal()
      if (!terminal) {
        return
      }
      disposeTerminalCompatibility = installPreviewTerminalCompatibility(terminal, {
        getSettings: args.getSettings
      })
      let pendingUserInputSignals = 0
      userInputDisposable = subscribeToTerminalUserInput(terminal, () => {
        pendingUserInputSignals = Math.min(32, pendingUserInputSignals + 1)
      })
      terminal.onData((data) => {
        if (!args.getInputEnabled()) {
          pendingUserInputSignals = 0
          return
        }
        const signaledUserInput = pendingUserInputSignals > 0
        if (signaledUserInput) {
          pendingUserInputSignals--
        }
        if (userInputDisposable ? !signaledUserInput : args.isReplaying()) {
          return
        }
        void window.api.terminalPreview.input(args.ptyId, data)
      })
      imeBridge = installPreviewImeBridge(terminal, {
        getKittyKeyboardFlags: args.getKittyKeyboardFlags
      })
      disposeKeyHandler = installPreviewTerminalKeyHandler({
        terminal,
        claimImeKeyEvent: (event) => imeBridge?.claimKeyEvent(event) ?? false,
        pasteClipboardText: (activeElement, source) =>
          void pasteClipboardText(activeElement, source),
        sendInput: (data) => args.getTerminal()?.input(data),
        getInputEnabled: args.getInputEnabled,
        getShortcutContext: () => ({
          clientPlatform: getShortcutPlatform(),
          macOptionAsAlt: args.getMacOptionAsAlt(),
          keybindings: useAppStore.getState().keybindings,
          terminalInput: args.getTerminalInput(),
          getKittyKeyboardFlags: args.getKittyKeyboardFlags,
          terminalShortcutPolicy: args.getSettings()?.terminalShortcutPolicy
        })
      })
    },
    dispose: () => {
      disposeAppMenuClipboard()
      userInputDisposable?.dispose()
      userInputDisposable = null
      imeBridge?.dispose()
      imeBridge = null
      disposeTerminalCompatibility?.()
      disposeTerminalCompatibility = null
      disposeKeyHandler?.()
      disposeKeyHandler = null
    }
  }
}

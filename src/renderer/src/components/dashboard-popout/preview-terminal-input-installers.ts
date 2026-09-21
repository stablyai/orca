import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { MacOptionAsAlt } from '@/components/terminal-pane/terminal-shortcut-policy'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { installPreviewImeBridge, type PreviewImeBridge } from './preview-terminal-ime-bridge'
import { installPreviewTerminalCompatibility } from './preview-terminal-compatibility'
import type { PreviewTerminalPasteSource } from './preview-terminal-paste'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'
import { installPreviewTerminalAppMenuClipboard } from './preview-terminal-app-menu-clipboard'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'
import { installTerminalNativeCopyGutterTrim } from '@/components/terminal-pane/terminal-native-copy-gutter'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { installPreviewTerminalDictation } from './preview-terminal-dictation'
import { installPreviewTerminalFileDrop } from './preview-terminal-file-drop'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'
import { installPreviewTerminalLinks } from './preview-terminal-links'

/** Cap on queued user-input signals; a burst beyond this is indistinguishable from a stuck key. */
const MAX_PENDING_USER_INPUT_SIGNALS = 32

export type PreviewInputInstallers = {
  installTargetInteractions: (container: HTMLElement, terminal: Terminal) => void
  invalidateTargetInteractions: () => void
  /** Bind the paste gestures that live on the container and outlive any one terminal. */
  installContainerClipboard: (container: HTMLElement) => void
  /** Bind a freshly opened terminal. Safe to call once per terminal instance. */
  install: (terminal: Terminal) => void
  /** Tear down everything bound to the current terminal. Idempotent. */
  dispose: () => void
}

/** IME, key policy, host quirks and input routing share one tracker and bridge; installed apart, a reconnect left one behind. */
export function createPreviewInputInstallers(args: {
  ptyId: string
  getPtyId: () => string
  getTerminal: () => Terminal | null
  kittyKeyboardModes: TerminalKittyKeyboardModeTracker
  pasteClipboardText: (activeElement: Element | null, source: PreviewTerminalPasteSource) => void
  getSettings: () => GlobalSettings | null
  getMacOptionAsAlt: () => MacOptionAsAlt
  getWorkspace?: () => PreviewTerminalWorkspace | undefined
  getTerminalInput: () => DashboardCardTerminalInput | null
  /** Non-zero while replayed bytes are still being parsed; those must not echo back to the PTY. */
  getReplayDepth: () => number
}): PreviewInputInstallers {
  let imeBridge: PreviewImeBridge | null = null
  let disposeNativeCopyGutterTrim: (() => void) | null = null
  let disposeKeyHandler: (() => void) | null = null
  let disposeTerminalCompatibility: (() => void) | null = null
  let userInputDisposable: { dispose: () => void } | null = null
  let disposeContainerClipboard: (() => void) | null = null
  let disposeFileDrop: (() => void) | null = null
  let disposeDictation: (() => void) | null = null
  let disposeLinks: (() => void) | null = null
  const invalidateTargetInteractions = (): void => {
    disposeLinks?.()
    disposeLinks = null
    disposeFileDrop?.()
    disposeFileDrop = null
    disposeDictation?.()
    disposeDictation = null
  }

  const installCompatibility = (terminal: Terminal): void => {
    disposeTerminalCompatibility = installPreviewTerminalCompatibility(terminal, {
      getSettings: args.getSettings
    })
  }

  const installInputRouting = (terminal: Terminal): void => {
    let pendingUserInputSignals = 0
    userInputDisposable = subscribeToTerminalUserInput(terminal, () => {
      pendingUserInputSignals = Math.min(
        MAX_PENDING_USER_INPUT_SIGNALS,
        pendingUserInputSignals + 1
      )
    })
    terminal.onData((data) => {
      const signaledUserInput = pendingUserInputSignals > 0
      if (signaledUserInput) {
        pendingUserInputSignals--
      }
      // Why: core's signal distinguishes real input from parser replies, so typing survives live replay without forwarding synthetic CPR/DA bytes.
      if (userInputDisposable ? !signaledUserInput : args.getReplayDepth() > 0) {
        return
      }
      void window.api.terminalPreview.input(args.ptyId, data)
    })
  }

  const installImeBridge = (terminal: Terminal): void => {
    // Why a live getter: kitty state can change between keydown and commit,
    // and the tracker outlives every reconnect inside this effect.
    imeBridge = installPreviewImeBridge(terminal, {
      getKittyKeyboardFlags: () => args.kittyKeyboardModes.flags
    })
  }

  const installKeyHandler = (terminal: Terminal): void => {
    disposeKeyHandler = installPreviewTerminalKeyHandler({
      terminal,
      claimImeKeyEvent: (event) => imeBridge?.claimKeyEvent(event) ?? false,
      pasteClipboardText: (activeElement, source) => args.pasteClipboardText(activeElement, source),
      // Why: route through terminal.input so the chord's bytes carry core's user-input signal, like typed keys.
      sendInput: (data) => terminal.input(data),
      getShortcutContext: () => ({
        clientPlatform: getShortcutPlatform(),
        macOptionAsAlt: args.getMacOptionAsAlt(),
        keybindings: useAppStore.getState().keybindings,
        terminalInput: args.getTerminalInput(),
        getKittyKeyboardFlags: () => args.kittyKeyboardModes.flags,
        terminalShortcutPolicy: args.getSettings()?.terminalShortcutPolicy
      })
    })
  }

  return {
    invalidateTargetInteractions,
    installTargetInteractions: (container, terminal) => {
      invalidateTargetInteractions()
      const workspace = args.getWorkspace?.()
      const isCurrent = (): boolean => {
        const current = args.getWorkspace?.()
        return (
          current?.worktreeId === workspace?.worktreeId &&
          current?.tabId === workspace?.tabId &&
          current?.paneKey === workspace?.paneKey &&
          current?.cwd === workspace?.cwd &&
          current?.executionHostId === workspace?.executionHostId
        )
      }
      disposeLinks = installPreviewTerminalLinks(terminal, { container, workspace, isCurrent })
      if (workspace) {
        disposeFileDrop = installPreviewTerminalFileDrop({
          ptyId: args.ptyId,
          container: container.parentElement ?? container,
          terminal,
          workspace,
          isCurrent
        })
      }
      disposeDictation = installPreviewTerminalDictation({
        ptyId: args.ptyId,
        getPtyId: args.getPtyId,
        container,
        terminal,
        getTerminalInput: args.getTerminalInput
      })
    },
    installContainerClipboard: (container) => {
      const disposeAppMenu = installPreviewTerminalAppMenuClipboard({
        container,
        getTerminal: args.getTerminal,
        pasteClipboardText: args.pasteClipboardText
      })
      const disposeRightClick = installPreviewTerminalRightClickPaste({
        container,
        getTerminal: args.getTerminal,
        // Same default as the pane: Windows users expect terminal-style right-click.
        isRightClickToPasteEnabled: () =>
          args.getSettings()?.terminalRightClickToPaste ?? isWindowsUserAgent(),
        pasteClipboardText: args.pasteClipboardText
      })
      disposeContainerClipboard = () => {
        disposeAppMenu()
        disposeRightClick()
      }
    },
    install: (terminal) => {
      disposeNativeCopyGutterTrim = installTerminalNativeCopyGutterTrim(terminal).dispose
      installCompatibility(terminal)
      installInputRouting(terminal)
      installImeBridge(terminal)
      installKeyHandler(terminal)
    },
    dispose: () => {
      invalidateTargetInteractions()
      disposeContainerClipboard?.()
      disposeContainerClipboard = null
      userInputDisposable?.dispose()
      userInputDisposable = null
      imeBridge?.dispose()
      imeBridge = null
      disposeTerminalCompatibility?.()
      disposeTerminalCompatibility = null
      disposeNativeCopyGutterTrim?.()
      disposeNativeCopyGutterTrim = null
      disposeKeyHandler?.()
      disposeKeyHandler = null
    }
  }
}

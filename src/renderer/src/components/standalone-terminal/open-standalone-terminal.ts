/** Reuse pane Unicode/link/IME/shortcut and kitty policy outside panes; callers own transport and parse-completion backpressure. */
import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useAppStore } from '@/store'
import type { MacOptionAsAlt } from '@/components/terminal-pane/terminal-shortcut-policy'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { installTerminalNativeCopyGutterTrim } from '@/components/terminal-pane/terminal-native-copy-gutter'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { installPreviewTerminalCompatibility } from '../dashboard-popout/preview-terminal-compatibility'
import { createPreviewClipboardPaster } from '../dashboard-popout/preview-terminal-paste'
import { installPreviewImeBridge } from '../dashboard-popout/preview-terminal-ime-bridge'
import { installPreviewTerminalKeyHandler } from '../dashboard-popout/preview-terminal-key-handler'
import { installPreviewTerminalAppMenuClipboard } from '../dashboard-popout/preview-terminal-app-menu-clipboard'
import { installPreviewTerminalRightClickPaste } from '../dashboard-popout/preview-terminal-right-click-paste'

export type StandaloneTerminalArgs = {
  container: HTMLElement
  options: ITerminalOptions & ITerminalInitOnlyOptions
  /** Owned by the caller so it can outlive a terminal the caller recreates. */
  kittyKeyboardModes: TerminalKittyKeyboardModeTracker
  /** Names the session for paste planning; a remote-runtime pty id routes as remote. */
  sessionKey: string
  /** The user's keystrokes and pastes, plus xterm's replies to output when `answersQueries`. */
  sendInput: (data: string) => boolean | Promise<boolean>
  /** Only the session’s sole emulator answers terminal queries; mirrors leave replies to the real pane. */
  answersQueries: boolean
  getSettings: () => GlobalSettings | null
  getMacOptionAsAlt: () => MacOptionAsAlt
  getTerminalInput: () => DashboardCardTerminalInput | null
}

export type StandaloneTerminal = {
  terminal: Terminal
  /** Scan live kitty pushes or apply replay idempotently; onDone signals parse completion for backpressure acknowledgment. */
  write: (chunk: string, options: { live: boolean; onDone?: () => void }) => void
  dispose: () => void
}

/** Null when xterm can't open in the container. */
export function openStandaloneTerminal(args: StandaloneTerminalArgs): StandaloneTerminal | null {
  const { container, kittyKeyboardModes } = args
  const terminal = new Terminal(args.options)
  try {
    terminal.open(container)
  } catch {
    terminal.dispose()
    return null
  }
  let disposed = false
  let replayDepth = 0

  const disposeCompatibility = installPreviewTerminalCompatibility(terminal, {
    getSettings: args.getSettings
  })
  const disposeNativeCopyGutterTrim = installTerminalNativeCopyGutterTrim(terminal).dispose

  let pendingUserInputSignals = 0
  const userInputDisposable = subscribeToTerminalUserInput(terminal, () => {
    pendingUserInputSignals = Math.min(32, pendingUserInputSignals + 1)
  })
  terminal.onData((data) => {
    const signaledUserInput = pendingUserInputSignals > 0
    if (signaledUserInput) {
      pendingUserInputSignals--
    }
    // Why: core's signal distinguishes real input from parser replies, so typing survives live replay without forwarding synthetic CPR/DA bytes.
    if (!args.answersQueries && (userInputDisposable ? !signaledUserInput : replayDepth > 0)) {
      return
    }
    void args.sendInput(data)
  })

  // Why a live getter: kitty state can change between keydown and commit.
  const imeBridge = installPreviewImeBridge(terminal, {
    getKittyKeyboardFlags: () => kittyKeyboardModes.flags
  })
  const pasteClipboardText = createPreviewClipboardPaster({
    ptyId: args.sessionKey,
    writeInput: args.sendInput,
    container,
    getTerminal: () => (disposed ? null : terminal),
    getTerminalInput: args.getTerminalInput,
    isDisposed: () => disposed
  })
  const disposeKeyHandler = installPreviewTerminalKeyHandler({
    terminal,
    claimImeKeyEvent: (event) => imeBridge?.claimKeyEvent(event) ?? false,
    pasteClipboardText: (activeElement, source) => void pasteClipboardText(activeElement, source),
    // Why: route through terminal.input so the chord's bytes carry core's user-input signal, like typed keys.
    sendInput: (data) => terminal.input(data),
    getShortcutContext: () => ({
      clientPlatform: getShortcutPlatform(),
      macOptionAsAlt: args.getMacOptionAsAlt(),
      keybindings: useAppStore.getState().keybindings,
      terminalInput: args.getTerminalInput(),
      getKittyKeyboardFlags: () => kittyKeyboardModes.flags,
      terminalShortcutPolicy: args.getSettings()?.terminalShortcutPolicy
    })
  })
  const disposeAppMenuClipboard = installPreviewTerminalAppMenuClipboard({
    container,
    getTerminal: () => (disposed ? null : terminal),
    pasteClipboardText: (activeElement, source) => void pasteClipboardText(activeElement, source)
  })
  const disposeRightClickPaste = installPreviewTerminalRightClickPaste({
    container,
    getTerminal: () => (disposed ? null : terminal),
    // Same default as the pane: Windows users expect terminal-style right-click.
    isRightClickToPasteEnabled: () =>
      args.getSettings()?.terminalRightClickToPaste ?? isWindowsUserAgent(),
    pasteClipboardText: (activeElement, source) => void pasteClipboardText(activeElement, source)
  })

  return {
    terminal,
    write: (chunk, { live, onDone }) => {
      // Snapshots redeliver one-time kitty pushes; replay must use idempotent sets rather than push twice.
      if (live) {
        kittyKeyboardModes.scan(chunk)
      } else {
        kittyKeyboardModes.scanReplay(chunk)
      }
      replayDepth++
      terminal.write(chunk, () => {
        replayDepth--
        onDone?.()
      })
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      userInputDisposable?.dispose()
      imeBridge?.dispose()
      disposeCompatibility()
      disposeKeyHandler()
      disposeNativeCopyGutterTrim()
      disposeAppMenuClipboard()
      disposeRightClickPaste()
      terminal.dispose()
    }
  }
}

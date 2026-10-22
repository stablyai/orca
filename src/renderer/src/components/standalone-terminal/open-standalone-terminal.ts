/**
 * One xterm outside the pane system, with everything a typed-into terminal needs: Orca's Unicode
 * widths, links and IME handling, the pane's copy/paste and shortcut policy, kitty keyboard flags,
 * and input that never forwards xterm's own replies to replayed output. Callers own the transport
 * (where output comes from, where input goes, and the backpressure ack in `write`'s callback).
 * Used by the agent dashboard preview and the plain SSH terminal.
 */
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
  /**
   * True when this xterm is the session's only emulator, so programs wait on its replies to
   * cursor, device and keyboard queries. A mirror (the preview) leaves them to the real pane.
   */
  answersQueries: boolean
  getSettings: () => GlobalSettings | null
  getMacOptionAsAlt: () => MacOptionAsAlt
  getTerminalInput: () => DashboardCardTerminalInput | null
}

export type StandaloneTerminal = {
  terminal: Terminal
  /**
   * `live`: new output, scanned for kitty pushes as they happen; otherwise replayed bytes, applied
   * idempotently. `onDone` runs once xterm has parsed the chunk, which is when to ack backpressure.
   */
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
      // Why: a redelivered snapshot repeats the TUI's one-time kitty push, so
      // replayed bytes must apply as idempotent sets (see the tracker's docs).
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

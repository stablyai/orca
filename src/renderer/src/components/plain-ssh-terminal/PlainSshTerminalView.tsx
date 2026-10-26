import { useEffect, useLayoutEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import type { ITheme, Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { syncPreviewTerminalLigatures } from '@/components/dashboard-popout/preview-terminal-ligatures'
import {
  buildPreviewAppearanceOptions,
  buildPreviewTerminalOptions
} from '@/components/dashboard-popout/preview-terminal-options'
import { openStandaloneTerminal } from '@/components/standalone-terminal/open-standalone-terminal'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'

export type PlainSshTerminalPhase =
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'failed'; message: string }
  | { kind: 'ended'; exitCode: number; signal?: number }

/** Output held while the open reply is in flight; a login banner or prompt is far smaller. */
const EARLY_DATA_CHAR_LIMIT = 256 * 1024
const SCROLLBACK_ROWS = 5_000

export function plainSshOpenFailureText(
  result: Extract<PlainSshTerminalOpenResult, { ok: false }>
): string {
  switch (result.reason) {
    case 'unknown-target':
      return translate(
        'auto.components.plainSshTerminal.unknownTarget',
        'This SSH host is no longer saved in Orca.'
      )
    case 'not-blocked':
      return translate(
        'auto.components.plainSshTerminal.notBlocked',
        'Orca can reach this host again, so use its terminals instead. Plain SSH is only for while Orca can’t set up on the host.'
      )
    case 'already-open':
      return translate(
        'auto.components.plainSshTerminal.alreadyOpen',
        'Another Orca window already has a plain SSH terminal open to this host.'
      )
    case 'cancelled':
      return translate(
        'auto.components.plainSshTerminal.cancelled',
        'This plain SSH terminal was closed before it started.'
      )
    case 'ssh-missing':
    case 'spawn-failed':
      return result.message
  }
}

function resolveThemeColors(
  settings: GlobalSettings | null,
  systemPrefersDark: boolean
): { theme: ITheme | null; mode: 'dark' | 'light' } {
  if (!settings) {
    return { theme: null, mode: 'dark' }
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  return {
    theme: composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    ),
    mode: appearance.mode
  }
}

/** One plain SSH session on Orca's standalone terminal; it starts on mount and hangs up on unmount. */
export function PlainSshTerminalView({
  targetId,
  hidden,
  onPhase
}: {
  targetId: string
  hidden: boolean
  onPhase: (phase: PlainSshTerminalPhase) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const macOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  // Why refs: keys and appearance read live values; a remount would hang up the SSH session.
  const settingsRef = useRef(settings)
  const systemPrefersDarkRef = useRef(systemPrefersDark)
  const macOptionAsAltRef = useRef(macOptionAsAlt)
  const onPhaseRef = useRef(onPhase)
  useLayoutEffect(() => {
    settingsRef.current = settings
    systemPrefersDarkRef.current = systemPrefersDark
    macOptionAsAltRef.current = macOptionAsAlt
    onPhaseRef.current = onPhase
  }, [settings, systemPrefersDark, macOptionAsAlt, onPhase])

  useEffect(() => {
    const container = containerRef.current
    const api = window.api.plainSsh
    if (!container || !api) {
      return
    }
    const mountSettings = settingsRef.current
    const { theme, mode } = resolveThemeColors(mountSettings, systemPrefersDarkRef.current)
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker({ kittyKeyboard: true })
    let sessionId: string | null = null
    const standalone = openStandaloneTerminal({
      container,
      options: buildPreviewTerminalOptions({
        settings: mountSettings,
        terminalInput: null,
        macOptionIsMeta: macOptionAsAltRef.current === 'true',
        theme,
        themeMode: mode,
        cols: 80,
        rows: 24,
        scrollback: SCROLLBACK_ROWS
      }),
      kittyKeyboardModes,
      sessionKey: `plain-ssh:${targetId}`,
      sendInput: (data) => {
        if (!sessionId) {
          return false
        }
        api.write({ sessionId, data })
        return true
      },
      // Why: this xterm is the SSH session's only emulator, so remote programs wait on its replies.
      answersQueries: true,
      getSettings: () => settingsRef.current,
      getMacOptionAsAlt: () => macOptionAsAltRef.current,
      getTerminalInput: () => null
    })
    if (!standalone) {
      onPhaseRef.current({
        kind: 'failed',
        message: translate(
          'auto.components.plainSshTerminal.terminalUnavailable',
          'Orca couldn’t open a terminal here.'
        )
      })
      return
    }
    const { terminal } = standalone
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminalRef.current = terminal
    fitRef.current = fit
    fit.fit()

    let phase: 'opening' | 'open' | 'done' = 'opening'
    let disposed = false
    const early: PlainSshTerminalEvent[] = []
    let earlyDataChars = 0
    // Why: output dropped past the early cap was never rendered, but main still counts it unacked.
    const droppedEarlyChars = new Map<string, number>()
    let unsubscribe: () => void = () => {}
    const finish = (next: PlainSshTerminalPhase | null): void => {
      phase = 'done'
      sessionId = null
      early.length = 0
      earlyDataChars = 0
      droppedEarlyChars.clear()
      unsubscribe()
      if (next) {
        onPhaseRef.current(next)
      }
    }
    const handle = (event: PlainSshTerminalEvent, id: string): void => {
      if (event.kind === 'data') {
        standalone.write(event.data, {
          live: true,
          onDone: () => {
            if (!disposed) {
              api.ack({ sessionId: id, chars: event.data.length })
            }
          }
        })
        return
      }
      // A clean logout closes the window; anything else keeps its output, with no shell after it.
      const clean = event.exitCode === 0 && !event.signal
      finish(clean ? null : { kind: 'ended', exitCode: event.exitCode, signal: event.signal })
      if (clean) {
        removePlainSshPanel(targetId)
      }
    }
    unsubscribe = api.onEvent((event) => {
      if (phase === 'opening') {
        // Exits are always kept: a session that ended before its id arrived must still end here.
        if (event.kind === 'exit') {
          early.push(event)
        } else if (
          // Why: once a session drops output, later chunks would leave a hole mid escape sequence.
          !droppedEarlyChars.has(event.sessionId) &&
          earlyDataChars + event.data.length <= EARLY_DATA_CHAR_LIMIT
        ) {
          earlyDataChars += event.data.length
          early.push(event)
        } else {
          droppedEarlyChars.set(
            event.sessionId,
            (droppedEarlyChars.get(event.sessionId) ?? 0) + event.data.length
          )
        }
      } else if (phase === 'open' && sessionId && event.sessionId === sessionId) {
        handle(event, sessionId)
      }
    })
    void api
      .open({ targetId, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) {
          if (result.ok) {
            api.close({ sessionId: result.sessionId })
          }
          return
        }
        if (!result.ok) {
          finish({ kind: 'failed', message: plainSshOpenFailureText(result) })
          return
        }
        const id = result.sessionId
        sessionId = id
        phase = 'open'
        onPhaseRef.current({ kind: 'open' })
        const dropped = droppedEarlyChars.get(id)
        droppedEarlyChars.clear()
        if (dropped) {
          api.ack({ sessionId: id, chars: dropped })
        }
        earlyDataChars = 0
        for (const event of early.splice(0)) {
          if (phase === 'open' && event.sessionId === id) {
            handle(event, id)
          }
        }
        terminal.focus()
      })
      .catch((error: unknown) => {
        if (!disposed) {
          finish({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    const resizeListener = terminal.onResize(({ cols, rows }) => {
      if (sessionId) {
        api.resize({ sessionId, cols, rows })
      }
    })
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit()
      }
    })
    observer.observe(container)
    return () => {
      disposed = true
      observer.disconnect()
      resizeListener.dispose()
      unsubscribe()
      if (sessionId) {
        api.close({ sessionId })
      }
      standalone.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [targetId])

  // Why: appearance and Option-as-Alt changes must land live; reopening would hang up ssh.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    const { theme, mode } = resolveThemeColors(settings, systemPrefersDark)
    Object.assign(terminal.options, {
      ...buildPreviewAppearanceOptions(settings, macOptionAsAlt === 'true'),
      theme: theme ?? undefined,
      minimumContrastRatio: resolveTerminalMinimumContrastRatio(
        theme?.background,
        mode,
        settings?.terminalMinimumContrastRatio
      )
    })
    syncPreviewTerminalLigatures(terminal, settings)
    // Why the guard: a minimized panel measures 0x0, and fitting would shrink the remote pty to 2x1.
    const container = containerRef.current
    if (!hidden && container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitRef.current?.fit()
    }
  }, [settings, systemPrefersDark, macOptionAsAlt, hidden])

  useEffect(() => {
    if (!hidden) {
      fitRef.current?.fit()
      terminalRef.current?.focus()
    }
  }, [hidden])

  // Why the theme's background: fit leaves a remainder of pixels beside the grid that must not show the card.
  const themeBackground = resolveThemeColors(settings, systemPrefersDark).theme?.background
  // Avoid double-painting xterm transparency; use allowTransparency’s setting test because rgba can still be opaque.
  const translucent =
    settings?.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
  const background = translucent ? undefined : themeBackground
  return (
    <div
      ref={containerRef}
      className="size-full min-h-0 overflow-hidden px-2 py-1"
      style={background ? { backgroundColor: background } : undefined}
    />
  )
}

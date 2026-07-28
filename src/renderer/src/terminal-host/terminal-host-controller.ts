// Single-terminal controller for the isolated terminal host page. Deliberately
// minimal: no app store, no React — nothing on this page's main thread besides
// xterm and the PTY IPC, so keystroke echo can't be blocked by app churn.
// App-level concerns (agent status rows, tab titles, forwarded shortcuts) are
// parsed here but dispatched to the embedding renderer via the bridge.
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import { extractAllOscTitles } from '../../../shared/agent-detection'
import type { TerminalHostAppearance } from '../../../shared/terminal-host-bridge'
import { shouldBypassXtermKeyboardEvent } from '../components/terminal-pane/xterm-bypass-policy'

/** Startup payload forwarded verbatim from the app's pendingStartupByTabId entry. */
export type TerminalHostStartup = {
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: unknown
  resumeProviderSession?: unknown
  launchToken?: string
  launchAgent?: string
  startupCommandDelivery?: unknown
}

export type TerminalHostConfig = {
  cwd: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  startup?: TerminalHostStartup
  theme: ITheme | null
  fontFamily: string
  fontSize: number
  lineHeight?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
}

function applyAppearance(terminal: Terminal, fit: FitAddon, appearance: TerminalHostAppearance): void {
  if (appearance.themeJson) {
    try {
      terminal.options.theme = JSON.parse(appearance.themeJson) as ITheme
    } catch {
      // Malformed theme push; keep the current theme.
    }
  }
  terminal.options.fontFamily = appearance.fontFamily
  terminal.options.fontSize = appearance.fontSize
  if (appearance.lineHeight !== undefined) {
    terminal.options.lineHeight = appearance.lineHeight
  }
  terminal.options.cursorStyle = appearance.cursorStyle ?? 'block'
  terminal.options.cursorBlink = appearance.cursorBlink ?? false
  fit.fit()
}

export async function startTerminalHost(
  container: HTMLElement,
  config: TerminalHostConfig
): Promise<void> {
  const terminal = new Terminal({
    allowProposedApi: true,
    scrollback: 10_000,
    theme: config.theme ?? undefined,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    ...(config.lineHeight !== undefined ? { lineHeight: config.lineHeight } : {}),
    cursorStyle: config.cursorStyle ?? 'block',
    cursorBlink: config.cursorBlink ?? false
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(container)
  // WebGL renderer keeps glyph drawing off this page's CPU path; canvas fallback
  // is xterm's default when the context can't be created.
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl')
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    terminal.loadAddon(webgl)
  } catch {
    // DOM/canvas renderer still works; the prototype measures input delay, not paint.
  }
  fit.fit()

  const isMac = navigator.userAgent.includes('Mac')
  // Chords the app owns (clipboard, menu accelerators) bypass xterm and are
  // replayed on the embedder document so app-level handlers still fire.
  terminal.attachCustomKeyEventHandler((e) => {
    const bypass = shouldBypassXtermKeyboardEvent(e, {
      isMac,
      hasSelection: terminal.hasSelection()
    })
    if (bypass && e.type === 'keydown') {
      window.api.terminalHost.sendToEmbedder({
        kind: 'keydown',
        init: {
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          repeat: e.repeat
        }
      })
    }
    return !bypass
  })

  const startup = config.startup
  const spawnResult = await window.api.pty.spawn({
    cols: terminal.cols,
    rows: terminal.rows,
    cwd: config.cwd,
    cwdFallback: 'worktree',
    ...(config.worktreeId ? { worktreeId: config.worktreeId } : {}),
    ...(config.tabId ? { tabId: config.tabId } : {}),
    ...(config.leafId ? { leafId: config.leafId } : {}),
    ...(startup?.command ? { command: startup.command } : {}),
    ...(startup?.env ? { env: startup.env } : {}),
    ...(startup?.envToDelete ? { envToDelete: startup.envToDelete } : {}),
    ...(startup?.launchConfig
      ? { launchConfig: startup.launchConfig as never }
      : {}),
    ...(startup?.resumeProviderSession
      ? { resumeProviderSession: startup.resumeProviderSession as never }
      : {}),
    ...(startup?.launchToken ? { launchToken: startup.launchToken } : {}),
    ...(startup?.launchAgent ? { launchAgent: startup.launchAgent as never } : {}),
    ...(startup?.startupCommandDelivery
      ? { startupCommandDelivery: startup.startupCommandDelivery as never }
      : {})
  })
  const ptyId = spawnResult.id
  window.api.terminalHost.sendToEmbedder({ kind: 'spawned', ptyId })
  if (spawnResult.replay) {
    terminal.write(spawnResult.replay)
  } else if (spawnResult.snapshot) {
    terminal.write(spawnResult.snapshot)
  } else if (spawnResult.coldRestore) {
    terminal.write(spawnResult.coldRestore.scrollback)
    window.api.pty.ackColdRestore(ptyId)
  }

  // OSC 9999 agent-status payloads are stripped before xterm sees them (same
  // as the legacy transport) and forwarded to the embedder, which owns the
  // store writes. OSC 0/2 titles forward for tab-title + status display.
  const processAgentStatus = createAgentStatusOscProcessor()
  let lastForwardedTitle: string | null = null

  // Cumulative ack keeps main's delivery accounting flowing for this guest
  // exactly like the app renderer's dispatcher would.
  let processedChars = 0
  window.api.pty.onData((payload) => {
    if (payload.id !== ptyId) {
      return
    }
    const chunkChars = Math.max(0, payload.rawLength ?? payload.data.length)
    const processed = processAgentStatus(payload.data)
    for (const statusPayload of processed.payloads) {
      window.api.terminalHost.sendToEmbedder({ kind: 'agent-status', ptyId, payload: statusPayload })
    }
    const titles = extractAllOscTitles(payload.data)
    const latestTitle = titles.at(-1) ?? null
    if (latestTitle !== null && latestTitle !== lastForwardedTitle) {
      lastForwardedTitle = latestTitle
      window.api.terminalHost.sendToEmbedder({ kind: 'title', ptyId, title: latestTitle })
    }
    if (processed.cleanData.length === 0) {
      processedChars += chunkChars
      window.api.pty.ackData(ptyId, chunkChars, processedChars)
      return
    }
    terminal.write(processed.cleanData, () => {
      processedChars += chunkChars
      window.api.pty.ackData(ptyId, chunkChars, processedChars)
    })
  })
  window.api.pty.onExit((payload) => {
    if (payload.id !== ptyId) {
      return
    }
    terminal.write('\r\n[process exited]\r\n')
    window.api.terminalHost.sendToEmbedder({ kind: 'exit', ptyId })
  })

  window.api.terminalHost.onAppearance((appearance) => {
    applyAppearance(terminal, fit, appearance)
    window.api.pty.resize(ptyId, terminal.cols, terminal.rows)
  })

  terminal.onData((data) => {
    window.api.pty.write(ptyId, data)
  })
  terminal.onResize(({ cols, rows }) => {
    window.api.pty.resize(ptyId, cols, rows)
  })

  const resizeObserver = new ResizeObserver(() => {
    fit.fit()
  })
  resizeObserver.observe(container)
  window.addEventListener('focus', () => terminal.focus())
  terminal.focus()
}

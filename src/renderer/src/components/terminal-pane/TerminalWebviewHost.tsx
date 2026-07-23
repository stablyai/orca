// Flag-gated (ORCA_TERMINAL_PROCESS_ISOLATION=1): renders a terminal in an
// isolated <webview> renderer process so app-renderer churn cannot block
// keystroke echo. Static config travels in the src URL query string (no
// init-message race); live appearance rides webview.send; guest events
// (spawn, agent status, titles, forwarded shortcuts) arrive via ipc-message.
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { resolveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { composeActiveTerminalTheme } from './terminal-appearance'
import { buildFontFamily } from './layout-serialization'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  TERMINAL_HOST_APPEARANCE_CHANNEL,
  TERMINAL_HOST_EVENT_CHANNEL,
  type TerminalHostAppearance,
  type TerminalHostEmbedderEvent
} from '../../../../shared/terminal-host-bridge'

type TerminalWebviewHostProps = {
  tabId: string
  worktreeId: string
  cwd?: string
  onPtyExit: (ptyId: string) => void
}

export function isTerminalProcessIsolationEnabled(): boolean {
  return window.api?.pty?.processIsolationEnabled === true
}

type PendingStartup = AppState['pendingStartupByTabId'][string]

function composeAppearance(settings: AppState['settings']): TerminalHostAppearance | null {
  if (!settings) {
    return null
  }
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const theme = composeActiveTerminalTheme(
    appearance.theme ?? getBuiltinTheme(appearance.themeName),
    settings
  )
  return {
    ...(theme ? { themeJson: JSON.stringify(theme) } : {}),
    fontFamily: buildFontFamily(settings.terminalFontFamily),
    fontSize: settings.terminalFontSize,
    ...(settings.terminalLineHeight !== undefined
      ? { lineHeight: settings.terminalLineHeight }
      : {}),
    ...(settings.terminalCursorStyle ? { cursorStyle: settings.terminalCursorStyle } : {}),
    ...(settings.terminalCursorBlink ? { cursorBlink: true } : {})
  }
}

function buildTerminalHostUrl(args: {
  tabId: string
  leafId: string
  worktreeId: string
  cwd: string | undefined
  startup: PendingStartup | undefined
  paneKey: string
}): string {
  const url = new URL('terminal-host.html', window.location.href)
  if (args.cwd) {
    url.searchParams.set('cwd', args.cwd)
  }
  url.searchParams.set('worktreeId', args.worktreeId)
  url.searchParams.set('tabId', args.tabId)
  url.searchParams.set('leafId', args.leafId)
  if (args.startup) {
    const { command, env, envToDelete, launchConfig, resumeProviderSession, launchToken, launchAgent, startupCommandDelivery } =
      args.startup
    url.searchParams.set(
      'startup',
      JSON.stringify({
        ...(command ? { command } : {}),
        env: {
          ...env,
          // Pane identity env mirrors the legacy path so agent hooks can
          // attribute their events back to this pane.
          ORCA_PANE_KEY: args.paneKey,
          ORCA_TAB_ID: args.tabId,
          ORCA_WORKTREE_ID: args.worktreeId,
          ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
        },
        ...(envToDelete ? { envToDelete } : {}),
        ...(launchConfig ? { launchConfig } : {}),
        ...(resumeProviderSession ? { resumeProviderSession } : {}),
        ...(launchToken ? { launchToken } : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...(startupCommandDelivery ? { startupCommandDelivery } : {})
      })
    )
  }
  // Initial appearance is baked into the URL; later changes ride the
  // appearance channel so the guest doesn't reload (a reload drops the shell).
  const appearance = composeAppearance(useAppStore.getState().settings)
  if (appearance) {
    if (appearance.themeJson) {
      url.searchParams.set('theme', appearance.themeJson)
    }
    url.searchParams.set('fontFamily', appearance.fontFamily)
    url.searchParams.set('fontSize', String(appearance.fontSize))
    if (appearance.lineHeight !== undefined) {
      url.searchParams.set('lineHeight', String(appearance.lineHeight))
    }
    if (appearance.cursorStyle) {
      url.searchParams.set('cursorStyle', appearance.cursorStyle)
    }
    if (appearance.cursorBlink) {
      url.searchParams.set('cursorBlink', '1')
    }
  }
  return url.toString()
}

export default function TerminalWebviewHost({
  tabId,
  worktreeId,
  cwd,
  onPtyExit
}: TerminalWebviewHostProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Why: paneKey leaf ids must be durable UUIDs (stable-pane-id contract);
  // the isolated pane has no layout leaf, so it mints one per mount.
  const [leafId] = useState(() => crypto.randomUUID())
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const consumeTabStartupCommand = useAppStore((store) => store.consumeTabStartupCommand)
  const onPtyExitRef = useRef(onPtyExit)
  onPtyExitRef.current = onPtyExit

  useEffect(() => {
    if (startup) {
      consumeTabStartupCommand(tabId)
    }
  }, [startup, tabId, consumeTabStartupCommand])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const paneKey = makePaneKey(tabId, leafId)
    let ptyId: string | null = null

    const dispatchAgentStatus = (
      payload: Extract<TerminalHostEmbedderEvent, { kind: 'agent-status' }>['payload'],
      eventPtyId: string
    ): void => {
      const routing = resolveAgentStatusConnectionRouting({ ptyId: eventPtyId })
      if (!routing) {
        return
      }
      useAppStore.getState().setAgentStatus(
        paneKey,
        payload,
        undefined,
        undefined,
        { tabId, worktreeId, connectionId: routing.connectionId },
        {
          ...(startup?.launchConfig ? { launchConfig: startup.launchConfig } : {}),
          ...(startup?.launchToken ? { launchToken: startup.launchToken } : {})
        }
      )
    }

    // Imperative creation matches the browser-pane pattern — webview is not a
    // typed JSX intrinsic in this codebase.
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.src = buildTerminalHostUrl({ tabId, leafId, worktreeId, cwd, startup, paneKey })
    webview.style.width = '100%'
    webview.style.height = '100%'
    webview.style.display = 'flex'

    let domReady = false
    let lastSentAppearance: string | null = null
    const pushAppearance = (): void => {
      if (!domReady) {
        return
      }
      const appearance = composeAppearance(useAppStore.getState().settings)
      if (!appearance) {
        return
      }
      const serialized = JSON.stringify(appearance)
      if (serialized === lastSentAppearance) {
        return
      }
      lastSentAppearance = serialized
      void webview.send(TERMINAL_HOST_APPEARANCE_CHANNEL, appearance)
    }

    const handleDomReady = (): void => {
      domReady = true
      // Why: the guest's xterm can only receive keys once the webview element
      // itself has focus; hand it over as soon as the guest page is ready.
      webview.focus()
      // Baseline so only future settings changes are pushed as diffs.
      lastSentAppearance = JSON.stringify(composeAppearance(useAppStore.getState().settings))
    }
    webview.addEventListener('dom-ready', handleDomReady)

    const handleIpcMessage = (event: Electron.IpcMessageEvent): void => {
      if (event.channel !== TERMINAL_HOST_EVENT_CHANNEL) {
        return
      }
      const payload = event.args[0] as TerminalHostEmbedderEvent | undefined
      if (!payload || typeof payload !== 'object') {
        return
      }
      const state = useAppStore.getState()
      switch (payload.kind) {
        case 'spawned': {
          ptyId = payload.ptyId
          state.updateTabPtyId(tabId, payload.ptyId)
          // Agents without native prompt hooks get a seeded working row, same
          // as the legacy path's applyInitialAgentStatus.
          const initialStatus = startup?.initialAgentStatus
          if (initialStatus) {
            dispatchAgentStatus(
              {
                state: 'working',
                prompt: initialStatus.prompt,
                agentType: initialStatus.agent
              },
              payload.ptyId
            )
          }
          break
        }
        case 'agent-status': {
          if (payload.ptyId === ptyId) {
            dispatchAgentStatus(payload.payload, payload.ptyId)
          }
          break
        }
        case 'title': {
          if (payload.ptyId === ptyId && payload.title.trim()) {
            state.updateTabTitle(tabId, payload.title)
          }
          break
        }
        case 'exit': {
          if (payload.ptyId === ptyId) {
            state.clearTabPtyId(tabId, payload.ptyId)
            onPtyExitRef.current(payload.ptyId)
          }
          break
        }
        case 'keydown': {
          // Replay app-owned chords (clipboard/menu shortcuts the guest's
          // xterm bypassed) on this document so app-level handlers fire.
          document.dispatchEvent(
            new KeyboardEvent('keydown', { ...payload.init, bubbles: true, cancelable: true })
          )
          break
        }
      }
    }
    webview.addEventListener('ipc-message', handleIpcMessage)

    const unsubscribeSettings = useAppStore.subscribe((state, previousState) => {
      if (state.settings !== previousState.settings) {
        pushAppearance()
      }
    })

    container.appendChild(webview)
    return () => {
      unsubscribeSettings()
      webview.removeEventListener('ipc-message', handleIpcMessage)
      webview.removeEventListener('dom-ready', handleDomReady)
      webview.remove()
    }
  }, [tabId, leafId, worktreeId, cwd, startup])

  return <div ref={containerRef} className="h-full w-full" />
}

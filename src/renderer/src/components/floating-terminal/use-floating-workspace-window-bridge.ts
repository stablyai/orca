import { useEffect } from 'react'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { registerVisibleTerminalTab } from '@/components/terminal-pane/parking/retention/foreground-terminal-tabs'
import { requestSleepingAgentWakeOnMount } from '@/lib/agent-session/resume/sleeping-agent-wake-requests'
import { useAppStore } from '@/store'
import { buildFloatingWorkspaceWindowSnapshot } from './build-floating-workspace-window-snapshot'
import { persistFloatingTerminalPanelOpen } from './floating-terminal-panel-view-state'
import { resolveFloatingWorkspaceMode } from './floating-workspace-open-mode'

const SNAPSHOT_DEBOUNCE_MS = 50
const FIT_POLL_MS = 50
const FIT_STABLE_POLLS = 8
const FIT_WAIT_CAP_MS = 2000

/** The in-window pane has fit once its drawn grid stops changing; the cap keeps a stuck pane from holding the dock. */
export function waitForInWindowPaneFit(ptyId: string | null): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + FIT_WAIT_CAP_MS
    let lastSize = ''
    let stable = 0
    const poll = (): void => {
      const screen = ptyId
        ? document.querySelector<HTMLElement>(
            `[data-floating-terminal-panel][aria-hidden="false"] [data-pty-id="${CSS.escape(ptyId)}"] .xterm-screen`
          )
        : null
      const size = screen ? `${screen.offsetWidth}x${screen.offsetHeight}` : ''
      stable = size && size === lastSize ? stable + 1 : 0
      lastSize = size
      if (!ptyId || stable >= FIT_STABLE_POLLS || Date.now() >= deadline) {
        resolve()
        return
      }
      setTimeout(poll, FIT_POLL_MS)
    }
    poll()
  })
}

function setPanelOpen(open: boolean): void {
  useAppStore.getState().setFloatingWorkspacePanelOpen(open)
  persistFloatingTerminalPanelOpen(open)
}

/** Keeps the pop-out window in step with the panel's open flag and the effective mode; returns its disposer. */
export function startFloatingWorkspaceWindowBridge(
  waitForFit: (ptyId: string | null) => Promise<void> = waitForInWindowPaneFit
): () => void {
  const api = window.api.floatingWorkspaceWindow
  const store = useAppStore
  let disposed = false
  let shown = false
  // Why: a reloaded renderer cannot see a window its crashed predecessor left mid-dock, so its first leave destroys.
  let hasWindow = true
  // Only the first sync is a restore or reload; every later show answers a user action and takes focus.
  let focusOnShow = false
  // Why: a show during a dock's fit wait supersedes that dock, so its late destroy must not remove the new window.
  let transition = 0
  let published = ''
  let publishTimer: ReturnType<typeof setTimeout> | null = null
  let stopStore: (() => void) | null = null
  let visibleTabId: string | null = null
  let releaseVisibleTab: (() => void) | null = null

  const publish = (): void => {
    const snapshot = buildFloatingWorkspaceWindowSnapshot(store.getState())
    const key = JSON.stringify(snapshot)
    // Why: the registration is a hibernation guard for the one terminal tab the window shows.
    const tabId = snapshot.activeTab?.kind === 'terminal' ? snapshot.activeTab.tabId : null
    if (tabId !== visibleTabId) {
      releaseVisibleTab?.()
      visibleTabId = tabId
      releaseVisibleTab = registerVisibleTerminalTab(tabId)
    }
    if (key !== published) {
      published = key
      api.publishSnapshot(snapshot)
    }
  }

  const stopPublishing = (): void => {
    if (publishTimer) {
      clearTimeout(publishTimer)
      publishTimer = null
    }
    stopStore?.()
    stopStore = null
    releaseVisibleTab?.()
    releaseVisibleTab = null
    visibleTabId = null
    published = ''
  }

  const leavePopout = async (): Promise<void> => {
    const wasShown = shown
    const leave = ++transition
    hasWindow = false
    shown = false
    stopPublishing()
    const state = store.getState()
    // Why: a shown window's open panel now renders in-window and claims the grid before the window lets go, so the agent resizes once; a hidden one stays closed.
    if (wasShown && state.settings?.floatingTerminalEnabled === true) {
      await waitForFit(buildFloatingWorkspaceWindowSnapshot(state).activeTab?.ptyId ?? null)
    }
    if (!disposed && leave === transition) {
      await api.destroy().catch(() => undefined)
    }
  }

  const sync = (): void => {
    const state = store.getState()
    if (resolveFloatingWorkspaceMode(state.settings) !== 'popout') {
      if (hasWindow) {
        void leavePopout()
      }
      return
    }
    if (state.floatingWorkspacePanelOpen && !shown) {
      shown = hasWindow = true
      transition += 1
      stopStore = store.subscribe(() => {
        publishTimer ??= setTimeout(() => {
          publishTimer = null
          publish()
        }, SNAPSHOT_DEBOUNCE_MS)
      })
      publish()
      const activeTab = buildFloatingWorkspaceWindowSnapshot(state).activeTab
      if (focusOnShow && activeTab?.kind === 'terminal') {
        requestSleepingAgentWakeOnMount(FLOATING_TERMINAL_WORKTREE_ID, [activeTab.tabId])
      }
      void api.show({ focus: focusOnShow }).catch(() => undefined)
    } else if (!state.floatingWorkspacePanelOpen && shown) {
      shown = false
      stopPublishing()
      void api.hide().catch(() => undefined)
    }
  }

  const unsubscribers = [
    store.subscribe(sync),
    api.onSnapshotRequested(() => {
      if (shown) {
        published = ''
        publish()
      }
    }),
    api.onDockRequested(() => {
      void store
        .getState()
        .updateSettings({ experimentalFloatingWorkspaceMode: 'in-window' })
        .catch(() => undefined)
    }),
    api.onHiddenByUser(() => {
      shown = false
      stopPublishing()
      setPanelOpen(false)
    }),
    api.onAgentAcked((paneKey, intent) => {
      store.getState().acknowledgeAgents([paneKey], undefined, intent)
    })
  ]
  sync()
  focusOnShow = true

  return () => {
    disposed = true
    stopPublishing()
    for (const unsubscribe of unsubscribers) {
      unsubscribe?.()
    }
  }
}

/** Mount once in the main renderer while the Floating Workspace pop-out experiment is on. */
export function useFloatingWorkspaceWindowBridge(): void {
  useEffect(() => startFloatingWorkspaceWindowBridge(), [])
}

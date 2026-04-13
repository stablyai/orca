/* oxlint-disable max-lines */
import { useEffect } from 'react'
import { useAppStore } from '../store'
import { applyUIZoom } from '@/lib/ui-zoom'
import {
  activateAndRevealWorktree,
  ensureWorktreeHasInitialTerminal
} from '@/lib/worktree-activation'
import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { nextEditorFontZoomLevel, computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { UpdateStatus } from '../../../shared/types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { resolveZoomTarget } from './resolve-zoom-target'
import { handleSwitchTab } from './ipc-tab-switch'

export { resolveZoomTarget } from './resolve-zoom-target'

const ZOOM_STEP = 0.5

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(
      window.api.repos.onChanged(() => {
        useAppStore.getState().fetchRepos()
      })
    )

    unsubs.push(
      window.api.worktrees.onChanged((data: { repoId: string }) => {
        useAppStore.getState().fetchWorktrees(data.repoId)
      })
    )

    unsubs.push(
      window.api.ui.onOpenSettings(() => {
        useAppStore.getState().setActiveView('settings')
      })
    )

    unsubs.push(
      window.api.ui.onToggleWorktreePalette(() => {
        const store = useAppStore.getState()
        if (store.activeModal === 'worktree-palette') {
          store.closeModal()
          return
        }
        store.openModal('worktree-palette')
      })
    )

    unsubs.push(
      window.api.ui.onOpenQuickOpen(() => {
        const store = useAppStore.getState()
        if (store.activeView !== 'settings' && store.activeWorktreeId !== null) {
          store.openModal('quick-open')
        }
      })
    )

    unsubs.push(
      window.api.ui.onJumpToWorktreeIndex((index) => {
        const store = useAppStore.getState()
        if (store.activeView === 'settings') {
          return
        }
        const visibleIds = getVisibleWorktreeIds()
        if (index < visibleIds.length) {
          activateAndRevealWorktree(visibleIds[index])
        }
      })
    )

    unsubs.push(
      window.api.ui.onToggleStatusBar(() => {
        const store = useAppStore.getState()
        store.setStatusBarVisible(!store.statusBarVisible)
      })
    )

    unsubs.push(
      window.api.ui.onActivateWorktree(({ repoId, worktreeId, setup }) => {
        void (async () => {
          const store = useAppStore.getState()
          await store.fetchWorktrees(repoId)
          // Why: CLI-created worktrees should feel identical to UI-created
          // worktrees. The renderer owns the "active worktree -> first tab"
          // behavior today, so we explicitly replay that activation sequence
          // after the runtime creates a worktree outside the renderer.
          store.setActiveRepo(repoId)
          store.setActiveView('terminal')
          store.setActiveWorktree(worktreeId)
          ensureWorktreeHasInitialTerminal(store, worktreeId, setup)

          store.revealWorktreeInSidebar(worktreeId)
        })().catch((error) => {
          console.error('Failed to activate CLI-created worktree:', error)
        })
      })
    )

    // Hydrate initial update status then subscribe to changes
    window.api.updater.getStatus().then((status) => {
      useAppStore.getState().setUpdateStatus(status as UpdateStatus)
    })

    unsubs.push(
      window.api.updater.onStatus((raw) => {
        const status = raw as UpdateStatus
        useAppStore.getState().setUpdateStatus(status)
      })
    )

    unsubs.push(
      window.api.updater.onClearDismissal(() => {
        useAppStore.getState().clearDismissedUpdateVersion()
      })
    )

    unsubs.push(
      window.api.ui.onFullscreenChanged((isFullScreen) => {
        useAppStore.getState().setIsFullScreen(isFullScreen)
      })
    )

    unsubs.push(
      window.api.browser.onGuestLoadFailed(({ browserPageId, loadError }) => {
        useAppStore.getState().updateBrowserPageState(browserPageId, {
          loading: false,
          loadError,
          canGoBack: false,
          canGoForward: false
        })
      })
    )

    unsubs.push(
      window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url }) => {
        const store = useAppStore.getState()
        const sourcePage = Object.values(store.browserPagesByWorkspace)
          .flat()
          .find((page) => page.id === browserPageId)
        if (!sourcePage) {
          return
        }
        // Why: the guest process can request "open this link in Orca", but it
        // does not own Orca's worktree/tab model. Resolve the source page's
        // worktree and create a new outer browser tab so the link opens as a
        // separate tab in the outer Orca tab bar.
        store.createBrowserTab(sourcePage.worktreeId, url, { title: url })
      })
    )

    // Shortcut forwarding for embedded browser guests whose webContents
    // capture keyboard focus and bypass the renderer's window-level keydown.
    unsubs.push(
      window.api.ui.onNewBrowserTab(() => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (worktreeId) {
          store.createBrowserTab(worktreeId, store.browserDefaultUrl ?? 'about:blank', {
            title: 'New Browser Tab'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onNewTerminalTab(() => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const newTab = store.createTab(worktreeId)
        store.setActiveTabType('terminal')
        // Why: replicate the full reconciliation from Terminal.tsx handleNewTab
        // so the new tab appends at the visual end instead of jumping to index 0
        // when tabBarOrderByWorktree is unset (e.g. restored worktrees).
        const currentTerminals = store.tabsByWorktree[worktreeId] ?? []
        const currentEditors = store.openFiles.filter((f) => f.worktreeId === worktreeId)
        const currentBrowsers = store.browserTabsByWorktree[worktreeId] ?? []
        const stored = store.tabBarOrderByWorktree[worktreeId]
        const termIds = currentTerminals.map((t) => t.id)
        const editorIds = currentEditors.map((f) => f.id)
        const browserIds = currentBrowsers.map((tab) => tab.id)
        const validIds = new Set([...termIds, ...editorIds, ...browserIds])
        const base = (stored ?? []).filter((id) => validIds.has(id))
        const inBase = new Set(base)
        for (const id of [...termIds, ...editorIds, ...browserIds]) {
          if (!inBase.has(id)) {
            base.push(id)
            inBase.add(id)
          }
        }
        const order = base.filter((id) => id !== newTab.id)
        order.push(newTab.id)
        store.setTabBarOrder(worktreeId, order)
      })
    )

    unsubs.push(
      window.api.ui.onCloseActiveTab(() => {
        const store = useAppStore.getState()
        if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
          store.closeBrowserTab(store.activeBrowserTabId)
        }
      })
    )

    unsubs.push(window.api.ui.onSwitchTab(handleSwitchTab))

    // Hydrate initial rate limit state then subscribe to push updates
    window.api.rateLimits.get().then((state) => {
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })

    unsubs.push(
      window.api.rateLimits.onUpdate((state) => {
        useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
      })
    )

    // Track SSH connection state changes so the renderer can show
    // disconnected indicators on remote worktrees.
    // Why: hydrate initial state for all known targets so worktree cards
    // reflect the correct connected/disconnected state on app launch.
    void (async () => {
      try {
        const targets = (await window.api.ssh.listTargets()) as {
          id: string
          label: string
        }[]
        // Why: populate target labels map so WorktreeCard (and other components)
        // can look up display labels without issuing per-card IPC calls.
        const labels = new Map<string, string>()
        for (const target of targets) {
          labels.set(target.id, target.label)
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (state) {
            useAppStore.getState().setSshConnectionState(target.id, state as SshConnectionState)
          }
        }
        useAppStore.getState().setSshTargetLabels(labels)
      } catch {
        // SSH may not be configured
      }
    })()

    unsubs.push(
      window.api.ssh.onStateChanged((data: { targetId: string; state: unknown }) => {
        useAppStore
          .getState()
          .setSshConnectionState(data.targetId, data.state as SshConnectionState)
      })
    )

    // Zoom handling for menu accelerators and keyboard fallback paths.
    unsubs.push(
      window.api.ui.onTerminalZoom((direction) => {
        const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } =
          useAppStore.getState()
        const target = resolveZoomTarget({
          activeView,
          activeTabType,
          activeElement: document.activeElement
        })
        if (target === 'terminal') {
          return
        }
        if (target === 'editor') {
          const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
          setEditorFontZoomLevel(next)
          void window.api.ui.set({ editorFontZoomLevel: next })

          // Why: use the same base font size the editor surfaces use (terminalFontSize)
          // and computeEditorFontSize to account for clamping, so the overlay percent
          // matches the actual rendered size.
          const baseFontSize = settings?.terminalFontSize ?? 13
          const actual = computeEditorFontSize(baseFontSize, next)
          const percent = Math.round((actual / baseFontSize) * 100)
          dispatchZoomLevelChanged('editor', percent)
          return
        }

        const current = window.api.ui.getZoomLevel()
        const rawNext =
          direction === 'in' ? current + ZOOM_STEP : direction === 'out' ? current - ZOOM_STEP : 0
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rawNext))

        applyUIZoom(next)
        void window.api.ui.set({ uiZoomLevel: next })

        dispatchZoomLevelChanged('ui', zoomLevelToPercent(next))
      })
    )

    return () => unsubs.forEach((fn) => fn())
  }, [])
}

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
import { createUpdateToastController } from './update-toast-controller'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'

const ZOOM_STEP = 0.5

export function resolveZoomTarget(args: {
  activeView: 'terminal' | 'settings'
  activeTabType: 'terminal' | 'editor' | 'browser'
  activeElement: unknown
}): 'terminal' | 'editor' | 'ui' {
  const { activeView, activeTabType, activeElement } = args
  const terminalInputFocused =
    typeof activeElement === 'object' &&
    activeElement !== null &&
    'classList' in activeElement &&
    typeof (activeElement as { classList?: { contains?: unknown } }).classList?.contains ===
      'function' &&
    (activeElement as { classList: { contains: (token: string) => boolean } }).classList.contains(
      'xterm-helper-textarea'
    )
  const editorFocused =
    typeof activeElement === 'object' &&
    activeElement !== null &&
    'closest' in activeElement &&
    typeof (activeElement as { closest?: unknown }).closest === 'function' &&
    Boolean(
      (
        activeElement as {
          closest: (selector: string) => Element | null
        }
      ).closest(
        '.monaco-editor, .diff-editor, .markdown-preview, .rich-markdown-editor, .rich-markdown-editor-shell'
      )
    )

  if (activeView !== 'terminal') {
    return 'ui'
  }
  if (activeTabType === 'editor' || editorFocused) {
    return 'editor'
  }
  // Why: terminal tabs should keep using per-pane terminal font zoom even when
  // focus leaves the xterm textarea (e.g. clicking tab bar/sidebar controls).
  // Falling back to UI zoom here would resize the whole app for a terminal-only
  // action and break parity with terminal zoom behavior.
  if (activeTabType === 'terminal' || terminalInputFocused) {
    return 'terminal'
  }
  return 'ui'
}

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []
    const updateToastController = createUpdateToastController()

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
        updateToastController.handleStatus(status)
      })
    )

    unsubs.push(
      window.api.ui.onFullscreenChanged((isFullScreen) => {
        useAppStore.getState().setIsFullScreen(isFullScreen)
      })
    )

    unsubs.push(
      window.api.browser.onGuestLoadFailed(({ browserTabId, loadError }) => {
        useAppStore.getState().updateBrowserTabPageState(browserTabId, {
          loading: false,
          loadError,
          canGoBack: false,
          canGoForward: false
        })
      })
    )

    // Shortcut forwarding for embedded browser guests whose webContents
    // capture keyboard focus and bypass the renderer's window-level keydown.
    unsubs.push(
      window.api.ui.onNewBrowserTab(() => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (worktreeId) {
          store.createBrowserTab(worktreeId, 'about:blank', { title: 'New Browser Tab' })
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
        // Why: this IPC fires only from browser guest webContents, so
        // activeTabType is always 'browser'. We intentionally skip the
        // editor case — closing dirty editor files requires the save
        // confirmation dialog which lives in Terminal.tsx component state.
        if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
          store.closeBrowserTab(store.activeBrowserTabId)
        }
      })
    )

    unsubs.push(
      window.api.ui.onSwitchTab((direction) => {
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const terminalTabs = store.tabsByWorktree[worktreeId] ?? []
        const editorFiles = store.openFiles.filter((f) => f.worktreeId === worktreeId)
        const browserTabs = store.browserTabsByWorktree[worktreeId] ?? []
        const terminalIds = terminalTabs.map((t) => t.id)
        const editorIds = editorFiles.map((f) => f.id)
        const browserIds = browserTabs.map((t) => t.id)
        const reconciledOrder = reconcileTabOrder(
          store.tabBarOrderByWorktree[worktreeId],
          terminalIds,
          editorIds,
          browserIds
        )
        const terminalIdSet = new Set(terminalIds)
        const editorIdSet = new Set(editorIds)
        const browserIdSet = new Set(browserIds)
        const allTabIds = reconciledOrder.map((id) => ({
          type: terminalIdSet.has(id)
            ? ('terminal' as const)
            : editorIdSet.has(id)
              ? ('editor' as const)
              : browserIdSet.has(id)
                ? ('browser' as const)
                : (null as never),
          id
        }))
        if (allTabIds.length > 1) {
          const currentId =
            store.activeTabType === 'editor'
              ? store.activeFileId
              : store.activeTabType === 'browser'
                ? store.activeBrowserTabId
                : store.activeTabId
          const idx = allTabIds.findIndex((t) => t.id === currentId)
          const next = allTabIds[(idx + direction + allTabIds.length) % allTabIds.length]
          if (next.type === 'terminal') {
            store.setActiveTab(next.id)
            store.setActiveTabType('terminal')
          } else if (next.type === 'browser') {
            store.setActiveBrowserTab(next.id)
            store.setActiveTabType('browser')
          } else {
            store.setActiveFile(next.id)
            store.setActiveTabType('editor')
          }
        }
      })
    )

    // Hydrate initial rate limit state then subscribe to push updates
    window.api.rateLimits.get().then((state) => {
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })

    unsubs.push(
      window.api.rateLimits.onUpdate((state) => {
        useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
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

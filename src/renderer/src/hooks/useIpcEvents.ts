import { useEffect } from 'react'
import { useAppStore } from '../store'
import { applyUIZoom } from '@/lib/ui-zoom'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-activation'
import { nextEditorFontZoomLevel, computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { UpdateStatus } from '../../../shared/types'
import { createUpdateToastController } from './update-toast-controller'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'

const ZOOM_STEP = 0.5

export function resolveZoomTarget(args: {
  activeView: 'terminal' | 'settings'
  activeTabType: 'terminal' | 'editor'
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

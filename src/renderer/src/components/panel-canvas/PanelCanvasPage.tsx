import React from 'react'
import { PictureInPicture2, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import {
  pinnedTerminalPanelCanvasWorktreeId,
  isPinnedTerminalPanelCanvasWorktreeId
} from '../../../../shared/pinned-terminal-panels'
import {
  MAX_PANEL_LAYOUT_LEAVES,
  MAX_PANEL_LAYOUTS,
  normalizePanelLayouts
} from '../../../../shared/panel-layouts'
import {
  collectCanvasLeaves,
  countCanvasLeaves,
  duplicateCanvasLeaf,
  layoutNodeFromCanvas,
  removeCanvasLeaf,
  setCanvasSplitSizes,
  splitCanvasLeaf,
  type PanelCanvasLeaf
} from '@/lib/panel-canvas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { destroyPinnedWebPanelWebview } from '@/components/pinned-web-panels/pinned-web-panel-webview'
import { CanvasNodeView, canvasWebviewId, type CanvasTreeCallbacks } from './PanelCanvasTree'

const EMPTY_TERMINAL_PANELS: readonly PinnedTerminalPanel[] = []
const EMPTY_WEB_PANELS: readonly PinnedWebPanel[] = []

/** The split-window canvas: renders the session's tile tree over the pinned
 *  panels. Stays mounted while a canvas exists so parked tiles keep their
 *  PTYs/webviews across view switches; tile tabs are reaped here when their
 *  leaf (or the whole canvas) goes away. */
const PanelCanvasPage = React.memo(function PanelCanvasPage(): React.JSX.Element | null {
  useTranslation()
  const root = useAppStore((s) => s.panelCanvasRoot)
  const activeView = useAppStore((s) => s.activeView)
  const activeLayoutId = useAppStore((s) => s.activePanelLayoutId)
  const setPanelCanvasRoot = useAppStore((s) => s.setPanelCanvasRoot)
  const setActivePanelLayoutId = useAppStore((s) => s.setActivePanelLayoutId)
  const closePanelCanvas = useAppStore((s) => s.closePanelCanvas)
  const terminalPanels = useAppStore(
    (s) => s.settings?.pinnedTerminalPanels ?? EMPTY_TERMINAL_PANELS
  )
  const webPanels = useAppStore((s) => s.settings?.pinnedWebPanels ?? EMPTY_WEB_PANELS)
  const panelLayouts = useAppStore((s) => s.settings?.panelLayouts)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [savingAs, setSavingAs] = React.useState(false)
  const [saveTitle, setSaveTitle] = React.useState('')

  const pageVisible = activeView === 'panel-canvas' && root !== null
  const leaves = React.useMemo(() => (root ? collectCanvasLeaves(root) : []), [root])

  // Why: a removed tile's PTY would otherwise keep running invisibly until app
  // exit — close every canvas-sentinel tab whose leaf no longer exists, and
  // destroy webviews for web leaves that went away.
  const prevLeavesRef = React.useRef<readonly PanelCanvasLeaf[]>([])
  React.useEffect(() => {
    const liveWorktreeIds = new Set(
      leaves.flatMap((leaf) =>
        leaf.kind === 'terminal' ? [pinnedTerminalPanelCanvasWorktreeId(leaf.panelId, leaf.id)] : []
      )
    )
    const state = useAppStore.getState()
    for (const worktreeId of Object.keys(state.tabsByWorktree)) {
      if (!isPinnedTerminalPanelCanvasWorktreeId(worktreeId) || liveWorktreeIds.has(worktreeId)) {
        continue
      }
      for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
        state.closeTab(tab.id, { reason: 'cleanup' })
      }
    }
    const liveLeafIds = new Set(leaves.map((leaf) => leaf.id))
    for (const prev of prevLeavesRef.current) {
      if (prev.kind === 'web' && !liveLeafIds.has(prev.id)) {
        destroyPinnedWebPanelWebview(canvasWebviewId(prev.id))
      }
    }
    prevLeavesRef.current = leaves
  }, [leaves])

  // Why: App unmounts this page the moment the canvas closes (root → null),
  // so the leaf-diff effect above never sees the final empty state — reap
  // every canvas tab and tile webview here instead.
  React.useEffect(
    () => () => {
      const state = useAppStore.getState()
      for (const worktreeId of Object.keys(state.tabsByWorktree)) {
        if (!isPinnedTerminalPanelCanvasWorktreeId(worktreeId)) {
          continue
        }
        for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
          state.closeTab(tab.id, { reason: 'cleanup' })
        }
      }
      for (const leaf of prevLeavesRef.current) {
        if (leaf.kind === 'web') {
          destroyPinnedWebPanelWebview(canvasWebviewId(leaf.id))
        }
      }
    },
    []
  )

  const activeLayout = (panelLayouts ?? []).find((layout) => layout.id === activeLayoutId)

  const onSplitLeaf = React.useCallback(
    (leafId: string, direction: 'row' | 'column') => {
      const current = useAppStore.getState().panelCanvasRoot
      if (!current || countCanvasLeaves(current) >= MAX_PANEL_LAYOUT_LEAVES) {
        return
      }
      // Why: splitting seeds the new tile with the same source (a second live
      // instance, e.g. two shells on one host); picking a different panel is
      // done from the sidebar's open-in-canvas actions instead.
      const target = collectCanvasLeaves(current).find((leaf) => leaf.id === leafId)
      if (!target) {
        return
      }
      setPanelCanvasRoot(splitCanvasLeaf(current, leafId, duplicateCanvasLeaf(target), direction))
    },
    [setPanelCanvasRoot]
  )

  const onRemoveLeaf = React.useCallback(
    (leafId: string) => {
      const current = useAppStore.getState().panelCanvasRoot
      if (!current) {
        return
      }
      setPanelCanvasRoot(removeCanvasLeaf(current, leafId))
    },
    [setPanelCanvasRoot]
  )

  const onResizeSplit = React.useCallback(
    (splitId: string, nextSizes: number[]) => {
      const current = useAppStore.getState().panelCanvasRoot
      if (!current) {
        return
      }
      setPanelCanvasRoot(setCanvasSplitSizes(current, splitId, nextSizes))
    },
    [setPanelCanvasRoot]
  )

  const splitDisabled = leaves.length >= MAX_PANEL_LAYOUT_LEAVES
  const callbacks = React.useMemo<CanvasTreeCallbacks>(
    () => ({ splitDisabled, onSplitLeaf, onRemoveLeaf, onResizeSplit }),
    [splitDisabled, onSplitLeaf, onRemoveLeaf, onResizeSplit]
  )

  const saveLayouts = React.useCallback(
    (nextLayouts: unknown) => {
      void updateSettings({ panelLayouts: normalizePanelLayouts(nextLayouts) })
    },
    [updateSettings]
  )

  const onSaveExisting = React.useCallback(() => {
    const current = useAppStore.getState().panelCanvasRoot
    if (!current || !activeLayout) {
      return
    }
    saveLayouts(
      (panelLayouts ?? []).map((layout) =>
        layout.id === activeLayout.id ? { ...layout, root: layoutNodeFromCanvas(current) } : layout
      )
    )
  }, [activeLayout, panelLayouts, saveLayouts])

  const onSaveAs = React.useCallback(() => {
    const current = useAppStore.getState().panelCanvasRoot
    const title = saveTitle.trim()
    if (!current || title.length === 0) {
      return
    }
    const id = crypto.randomUUID()
    saveLayouts([...(panelLayouts ?? []), { id, title, root: layoutNodeFromCanvas(current) }])
    setActivePanelLayoutId(id)
    setSavingAs(false)
    setSaveTitle('')
  }, [saveTitle, panelLayouts, saveLayouts, setActivePanelLayoutId])

  const onDetach = React.useCallback(() => {
    const current = useAppStore.getState().panelCanvasRoot
    if (!current) {
      return
    }
    const title =
      useAppStore
        .getState()
        .settings?.panelLayouts?.find(
          (layout) => layout.id === useAppStore.getState().activePanelLayoutId
        )?.title ?? null
    void window.api.panelCanvasPopout
      .open({
        layout: layoutNodeFromCanvas(current),
        layoutId: useAppStore.getState().activePanelLayoutId,
        title
      })
      .then((opened) => {
        // Why: the canvas moves, it doesn't fork — close here only once the
        // popout exists so a failed open never loses the tree.
        if (opened) {
          useAppStore.getState().closePanelCanvas()
        }
      })
  }, [])

  if (root === null) {
    return null
  }

  return (
    <div className={cn('min-h-0 flex-1 flex-col', pageVisible ? 'flex' : 'hidden')}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
          {activeLayout?.title ??
            translate('auto.components.panel-canvas.PanelCanvasPage.scratchTitle', 'Panel canvas')}
        </span>
        {savingAs ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              onSaveAs()
            }}
          >
            <Input
              autoFocus
              value={saveTitle}
              onChange={(event) => setSaveTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSavingAs(false)
                }
              }}
              placeholder={translate(
                'auto.components.panel-canvas.PanelCanvasPage.layoutNamePlaceholder',
                'Layout name'
              )}
              className="h-6 w-40 text-[12px]"
            />
            <Button type="submit" size="sm" className="h-6 px-2 text-[12px]">
              {translate('auto.components.panel-canvas.PanelCanvasPage.saveConfirm', 'Save')}
            </Button>
          </form>
        ) : (
          <>
            {activeLayout ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[12px]"
                onClick={onSaveExisting}
              >
                <Save className="size-3" strokeWidth={1.75} />
                {translate('auto.components.panel-canvas.PanelCanvasPage.save', 'Save')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[12px]"
              disabled={(panelLayouts ?? []).length >= MAX_PANEL_LAYOUTS && !activeLayout}
              onClick={() => setSavingAs(true)}
            >
              {translate('auto.components.panel-canvas.PanelCanvasPage.saveAs', 'Save as…')}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={translate(
            'auto.components.panel-canvas.PanelCanvasPage.detach',
            'Detach into its own window'
          )}
          title={translate(
            'auto.components.panel-canvas.PanelCanvasPage.detach',
            'Detach into its own window'
          )}
          onClick={onDetach}
        >
          <PictureInPicture2 className="size-3.5" strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={translate(
            'auto.components.panel-canvas.PanelCanvasPage.close',
            'Close canvas'
          )}
          onClick={closePanelCanvas}
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 p-1.5">
        <CanvasNodeView
          node={root}
          visible={pageVisible}
          terminalPanels={terminalPanels}
          webPanels={webPanels}
          callbacks={callbacks}
        />
      </div>
    </div>
  )
})

export default PanelCanvasPage

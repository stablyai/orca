import React from 'react'
import { PetOverlay } from '../pet/PetOverlay'
import { PictureInPicture2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import type { PanelLayoutNode, PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import { MAX_PANEL_LAYOUT_LEAVES, normalizePanelLayouts } from '../../../../shared/panel-layouts'
import {
  canvasNodeFromLayout,
  collectCanvasLeaves,
  countCanvasLeaves,
  canvasLeafFromSplitChoice,
  layoutNodeFromCanvas,
  removeCanvasLeaf,
  setCanvasSplitSizes,
  splitCanvasLeaf,
  type PanelCanvasNode,
  type PanelCanvasPanelLeaf
} from '@/lib/panel-canvas'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PanelSplitChoice } from '@/lib/panel-split-candidates'
import { CanvasNodeView, type CanvasTreeCallbacks } from './PanelCanvasTree'
import { SlimTerminalTile } from './SlimTerminalTile'

const EMPTY_TERMINAL_PANELS: readonly PinnedTerminalPanel[] = []
const EMPTY_WEB_PANELS: readonly PinnedWebPanel[] = []

/** Root of a detached panel-canvas window. Owns its canvas tree as local
 *  state (the popout has no sidebar/views); terminal tiles run on the slim
 *  popout PTY channel, web tiles reuse the pinned-panel webview registry
 *  (fresh per window). Reattach hands the tree back to the main window. */
export function PanelCanvasPopoutRoot(): React.JSX.Element {
  useTranslation()
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const terminalPanels = useAppStore(
    (s) => s.settings?.pinnedTerminalPanels ?? EMPTY_TERMINAL_PANELS
  )
  const webPanels = useAppStore((s) => s.settings?.pinnedWebPanels ?? EMPTY_WEB_PANELS)
  const settingsLoaded = useAppStore((s) => s.settings !== null)
  const [root, setRoot] = React.useState<PanelCanvasNode | null>(null)
  const [boot, setBoot] = React.useState<{ layoutId: string | null; title: string | null }>({
    layoutId: null,
    title: null
  })
  const [bootFailed, setBootFailed] = React.useState(false)

  React.useEffect(() => {
    void fetchSettings()
    // Why: panel edits in the main window (rename, command/host changes) must
    // land here live — tiles resolve their panel from settings on render.
    const unsubscribe = window.api.settings.onChanged((updates) => {
      const current = useAppStore.getState().settings
      if (current) {
        useAppStore.setState({ settings: { ...current, ...updates } })
      }
    })
    return unsubscribe
  }, [fetchSettings])

  React.useEffect(() => {
    void window.api.panelCanvasPopout.getBootPayload().then((payload) => {
      // Why: the payload crossed a window boundary — run it through the same
      // normalizer as persisted layouts before trusting the shape.
      const normalized = payload
        ? normalizePanelLayouts([
            { id: 'popout', title: payload.title ?? 'canvas', root: payload.layout }
          ])
        : []
      if (normalized.length === 0) {
        setBootFailed(true)
        return
      }
      setBoot({ layoutId: payload?.layoutId ?? null, title: payload?.title ?? null })
      setRoot(canvasNodeFromLayout(normalized[0].root))
    })
  }, [])

  const onSplitLeaf = React.useCallback(
    (leafId: string, direction: 'row' | 'column', choice: PanelSplitChoice) => {
      setRoot((current) => {
        if (!current || countCanvasLeaves(current) >= MAX_PANEL_LAYOUT_LEAVES) {
          return current
        }
        const target = collectCanvasLeaves(current).find((leaf) => leaf.id === leafId)
        if (!target) {
          return current
        }
        return splitCanvasLeaf(
          current,
          leafId,
          canvasLeafFromSplitChoice(choice, target),
          direction
        )
      })
    },
    []
  )

  const onRemoveLeaf = React.useCallback((leafId: string) => {
    setRoot((current) => {
      const next = current ? removeCanvasLeaf(current, leafId) : null
      if (next === null) {
        // Why: an empty popout is a dead window — closing matches removing
        // the last tile of the in-app canvas, which closes the view.
        window.close()
      }
      return next
    })
  }, [])

  const onResizeSplit = React.useCallback((splitId: string, sizes: number[]) => {
    setRoot((current) => (current ? setCanvasSplitSizes(current, splitId, sizes) : current))
  }, [])

  const splitDisabled = root !== null && countCanvasLeaves(root) >= MAX_PANEL_LAYOUT_LEAVES
  const renderTerminalTile = React.useCallback(
    (leaf: PanelCanvasPanelLeaf, panel: PinnedTerminalPanel) => (
      <SlimTerminalTile spawnKey={leaf.id} host={panel.host ?? null} command={panel.command} />
    ),
    []
  )
  const callbacks = React.useMemo<CanvasTreeCallbacks>(
    () => ({ splitDisabled, onSplitLeaf, onRemoveLeaf, onResizeSplit, renderTerminalTile }),
    [splitDisabled, onSplitLeaf, onRemoveLeaf, onResizeSplit, renderTerminalTile]
  )

  const onReattach = React.useCallback(() => {
    if (root === null) {
      return
    }
    const layout: PanelLayoutNode = layoutNodeFromCanvas(root)
    // Why: main closes this window once the main window adopts the tree; the
    // popout's PTYs are reaped by the window-closed handler.
    void window.api.panelCanvasPopout.reattach({
      layout,
      layoutId: boot.layoutId,
      title: boot.title
    })
  }, [root, boot])

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* P5: a popout is its own pet surface, so the pet can walk out of the
          main window and into a detached canvas. It registers as
          'popout-window' rather than masquerading as the main window. */}
      <PetOverlay surfaceKind="popout-window" />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
          {boot.title ??
            translate('auto.components.panel-canvas.PanelCanvasPopoutRoot.title', 'Panel canvas')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[12px]"
          disabled={root === null}
          onClick={onReattach}
        >
          <PictureInPicture2 className="size-3" strokeWidth={1.75} />
          {translate('auto.components.panel-canvas.PanelCanvasPopoutRoot.reattach', 'Reattach')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={translate(
            'auto.components.panel-canvas.PanelCanvasPopoutRoot.close',
            'Close window'
          )}
          onClick={() => window.close()}
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 p-1.5">
        {root !== null && settingsLoaded ? (
          <CanvasNodeView
            node={root}
            visible
            terminalPanels={terminalPanels}
            webPanels={webPanels}
            callbacks={callbacks}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
            {bootFailed
              ? translate(
                  'auto.components.panel-canvas.PanelCanvasPopoutRoot.bootFailed',
                  'This window has no canvas payload — close it and detach again.'
                )
              : translate('auto.components.panel-canvas.PanelCanvasPopoutRoot.loading', 'Loading…')}
          </div>
        )}
      </div>
    </div>
  )
}

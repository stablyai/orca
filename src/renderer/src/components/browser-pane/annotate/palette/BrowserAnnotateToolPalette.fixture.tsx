import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { MarkupPaletteTools, type MarkupPaletteDensity } from './MarkupPaletteTools'
import { BrowserAnnotatePaletteNotes } from './browser-annotate-palette-send'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePalettePosition } from './annotate-palette-position-store'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'
import BrowserFind from '../../assemble-chrome/find/BrowserFind'

const noop = (): void => {}
// Fit compaction steps one level every two frames; let it settle before the shot.
const settleFit = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

/** A page-sized backdrop with the palette over it, as it sits in the browser pane. */
function PalettePage({
  initialTool,
  notes = 0,
  picked = false,
  ratio = 0.5,
  y = 1,
  busy = false,
  hint = 'Click an element to add feedback for the agent.',
  waiting = false,
  findOpen = false,
  hintIsError = false
}: {
  initialTool: BrowserAnnotateTool
  notes?: number
  picked?: boolean
  ratio?: number
  /** Vertical place as a fraction of the free travel (0 = top, 1 = the default bottom). */
  y?: number
  /** A loud, colourful page, to check the palette still stands out. */
  busy?: boolean
  hint?: string
  waiting?: boolean
  findOpen?: boolean
  /** An error status, which stays shown on a compacted palette. */
  hintIsError?: boolean
}): React.JSX.Element {
  const boundsRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const [tool, setTool] = useState(initialTool)
  // Find really closes (Esc or its close button) and reopens from the header, as in the pane.
  const [findShown, setFindShown] = useState(findOpen)
  // The palette reads the app-wide saved position; seed it before the palette mounts.
  useState(() => setAnnotatePalettePosition({ x: ratio, y }))
  const [drawSlot, setDrawSlot] = useState<HTMLElement | null>(null)
  const [drawDensity, setDrawDensity] = useState<MarkupPaletteDensity>('full')
  return (
    <div
      ref={boundsRef}
      className="relative h-40 overflow-hidden rounded-md border border-border bg-background"
    >
      <div className="flex h-10 items-center gap-4 border-b border-border px-4 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Acme</span>
        <span>Pricing</span>
        <span>Docs</span>
        <span>Blog</span>
        {findOpen ? (
          <button type="button" className="ml-auto" onClick={() => setFindShown(true)}>
            Open find
          </button>
        ) : null}
      </div>
      {busy ? (
        <div className="absolute inset-x-0 top-10 bottom-0 bg-[linear-gradient(120deg,#f97316,#ec4899_35%,#6366f1_65%,#22d3ee)] p-4 text-2xl leading-tight font-bold text-white">
          Ship faster with Acme. Pricing · Docs · Blog · Ship faster with Acme. Pricing · Docs ·
          Blog
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">Page content</div>
      )}
      {findOpen ? (
        <BrowserFind
          browserPageId="sample-page"
          isOpen={findShown}
          onClose={() => setFindShown(false)}
          webviewRef={webviewRef}
        />
      ) : null}
      <BrowserAnnotateToolPalette
        boundsRef={boundsRef}
        pageId={null}
        ownerPageId="sample-page"
        activeTool={tool}
        onSelectTool={setTool}
        onDone={noop}
        canPickElements
        showKeyHints
        drawWaitingForPage={waiting}
        drawHasActions={tool === 'draw' && !waiting}
        hint={waiting ? 'Waiting for page…' : tool === 'draw' ? '' : hint}
        hintIsError={hintIsError}
        hintKeepsWhenCompact={waiting || hintIsError}
        annotateActions={
          notes > 0
            ? (short) => (
                <BrowserAnnotatePaletteNotes
                  count={notes}
                  short={short}
                  onShowNotes={noop}
                  notesOpen={false}
                  sendOpen={false}
                  onSendOpenChange={noop}
                  sendDisabled={false}
                  sendMenu={null}
                />
              )
            : null
        }
        grabCopyDone={false}
        grabPicked={picked}
        grabCanScreenshot={picked}
        onGrabCopy={noop}
        onGrabScreenshot={noop}
        onDrawSlotChange={setDrawSlot}
        onDrawDensityChange={setDrawDensity}
      />
      {tool === 'draw' && drawSlot && !waiting ? (
        <DrawSlotContent slot={drawSlot} density={drawDensity} />
      ) : null}
    </div>
  )
}

/** Mirrors MarkupOverlay's palette controls, without a frozen screenshot behind them. */
function DrawSlotContent({
  slot,
  density
}: {
  slot: HTMLElement
  density: MarkupPaletteDensity
}): React.JSX.Element {
  return createPortal(
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <MarkupPaletteTools
        density={density}
        tool="pen"
        onToolChange={noop}
        color="#ef4444"
        onColorChange={noop}
        width={4}
        onWidthChange={noop}
        fontSize={16}
        onFontSizeChange={noop}
        canUndo={false}
        canRedo={false}
        onUndo={noop}
        onRedo={noop}
        onClear={noop}
      />
      <Button
        size={density === 'compact' ? 'icon-xs' : 'xs'}
        className="shrink-0"
        disabled
        aria-label="Copy markup"
      >
        {density === 'compact' ? <Copy className="size-3.5" /> : 'Copy markup'}
      </Button>
    </div>,
    slot
  )
}

export const annotate = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="annotate" />
})

export const annotateWithNotes = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="annotate" notes={3} hint="" />
})

export const grabPicked = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="copy" picked hint="" />
})

export const draw = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="draw" />
})

export const movedLeft = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="annotate" ratio={0} />
})

export const movedUp = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="copy" picked ratio={0.3} y={0} />
})

export const grabOverBusyPage = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="copy" busy />
})

export const narrow = defineFixture({
  width: 320,
  interact: settleFit,
  render: () => <PalettePage initialTool="copy" picked />
})

export const drawNarrow = defineFixture({
  width: 420,
  interact: settleFit,
  render: () => <PalettePage initialTool="draw" />
})

export const drawNarrowest = defineFixture({
  width: 320,
  interact: settleFit,
  render: () => <PalettePage initialTool="draw" />
})

export const annotateWithNotesNarrow = defineFixture({
  width: 420,
  interact: settleFit,
  render: () => <PalettePage initialTool="annotate" notes={3} hint="" />
})

export const waitingForPage = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="draw" waiting />
})

export const waitingForPageCompact = defineFixture({
  width: 240,
  interact: settleFit,
  render: () => <PalettePage initialTool="draw" waiting />
})

export const findGeometry = defineFixture({
  width: 650,
  interact: settleFit,
  render: () => <PalettePage initialTool="annotate" ratio={0} y={0} findOpen />
})

export const annotate560 = defineFixture({
  width: 560,
  interact: settleFit,
  render: () => <PalettePage initialTool="annotate" />
})

export const annotate420 = defineFixture({
  width: 420,
  interact: settleFit,
  render: () => <PalettePage initialTool="annotate" />
})

export const annotate320 = defineFixture({
  width: 320,
  interact: settleFit,
  render: () => <PalettePage initialTool="annotate" />
})

export const rightGrab560 = defineFixture({
  width: 560,
  interact: settleFit,
  render: () => <PalettePage initialTool="copy" ratio={1} />
})

export const rightGrab420 = defineFixture({
  width: 420,
  interact: settleFit,
  render: () => <PalettePage initialTool="copy" ratio={1} />
})

export const grabErrorCompact = defineFixture({
  width: 320,
  interact: settleFit,
  render: () => (
    <PalettePage
      initialTool="copy"
      hint="Grab failed: Could not start element selection on this page"
      hintIsError
    />
  )
})

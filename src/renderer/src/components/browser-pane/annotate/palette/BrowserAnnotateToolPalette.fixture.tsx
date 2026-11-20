import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { MarkupPaletteTools, type MarkupPaletteDensity } from './MarkupPaletteTools'
import { BrowserAnnotatePaletteNotes } from './browser-annotate-palette-send'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePaletteRatio } from './annotate-palette-position-store'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'

const noop = (): void => {}

/** A page-sized backdrop with the palette over it, as it sits in the browser pane. */
function PalettePage({
  initialTool,
  notes = 0,
  picked = false,
  ratio = 0.5,
  hint = 'Click an element to add feedback for the agent.',
  waiting = false
}: {
  initialTool: BrowserAnnotateTool
  notes?: number
  picked?: boolean
  ratio?: number
  hint?: string
  waiting?: boolean
}): React.JSX.Element {
  const boundsRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState(initialTool)
  // The palette reads the app-wide saved position; seed it before the palette mounts.
  useState(() => setAnnotatePaletteRatio(ratio))
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
      </div>
      <div className="p-4 text-sm text-muted-foreground">Page content</div>
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
        hint={waiting ? 'Waiting for page…' : tool === 'draw' ? '' : hint}
        hintIsError={false}
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
      <Button size="xs" className="shrink-0" disabled>
        {density === 'compact' ? 'Copy' : 'Copy markup'}
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

export const narrow = defineFixture({
  width: 320,
  render: () => <PalettePage initialTool="copy" picked />
})

export const drawNarrow = defineFixture({
  width: 420,
  render: () => <PalettePage initialTool="draw" />
})

export const drawNarrowest = defineFixture({
  width: 320,
  render: () => <PalettePage initialTool="draw" />
})

export const annotateWithNotesNarrow = defineFixture({
  width: 420,
  render: () => <PalettePage initialTool="annotate" notes={3} hint="" />
})

export const waitingForPage = defineFixture({
  width: 900,
  render: () => <PalettePage initialTool="draw" waiting />
})

export const waitingForPageCompact = defineFixture({
  width: 240,
  render: () => <PalettePage initialTool="draw" waiting />
})

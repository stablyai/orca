// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePalettePosition } from './annotate-palette-position-store'

const PAGE_ID = 'page-1'

beforeEach(() => setAnnotatePalettePosition({ x: 0.5, y: 0 }))
afterEach(() => cleanup())

describe('the palette in the Tab order', () => {
  it('keeps the palette in the Tab order while drawing', () => {
    function Harness(): React.JSX.Element {
      const boundsRef = useRef<HTMLDivElement>(null)
      const [open, setOpen] = useState(false)
      useEffect(() => setOpen(true), [])
      return (
        <TooltipProvider>
          <div ref={boundsRef}>
            {open ? (
              <BrowserAnnotateToolPalette
                boundsRef={boundsRef}
                pageId={null}
                ownerPageId={PAGE_ID}
                activeTool="draw"
                onSelectTool={vi.fn()}
                onDone={vi.fn()}
                canPickElements
                showKeyHints
                hint=""
                hintIsError={false}
                annotateActions={null}
                grabCopyDone={false}
                grabPicked={false}
                grabCanScreenshot={false}
                onGrabCopy={vi.fn()}
                onGrabScreenshot={vi.fn()}
                onDrawSlotChange={vi.fn()}
                onDrawDensityChange={vi.fn()}
              />
            ) : null}
          </div>
        </TooltipProvider>
      )
    }
    const view = render(<Harness />)

    // The selected tool is the group's one Tab stop (arrows move within it), and Done follows it.
    const draw = view.getByRole('button', { name: 'Draw' })
    expect(draw.tabIndex).toBe(0)
    expect(draw.closest('[inert]')).toBeNull()
    const done = view.getByRole('button', { name: /Done/ })
    expect(done.tabIndex).toBe(0)
    expect(draw.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

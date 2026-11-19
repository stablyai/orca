// @vitest-environment happy-dom
import { useEffect, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { getAnnotatePaletteRatio, setAnnotatePaletteRatio } from './annotate-palette-position-store'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'

const BOUNDS_WIDTH = 900
const PALETTE_WIDTH = 300

beforeEach(() => {
  setAnnotatePaletteRatio(0.5)
  // happy-dom has no layout; give the page and the palette real widths so placement and the grip engage.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testBounds !== undefined ? BOUNDS_WIDTH : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-browser-annotate-palette') ? PALETTE_WIDTH : 0
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Harness(props: {
  activeTool: BrowserAnnotateTool
  onSelectTool?: (tool: BrowserAnnotateTool) => void
  onDone?: () => void
  onGrabCopy?: () => void
  onGrabScreenshot?: () => void
  grabPicked?: boolean
}): React.JSX.Element {
  const boundsRef = useRef<HTMLDivElement>(null)
  // The page is already on screen before the palette opens, as in the app.
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(true), [])
  return (
    <TooltipProvider>
      <div ref={boundsRef} data-test-bounds="">
        {open ? (
          <BrowserAnnotateToolPalette
            boundsRef={boundsRef}
            pageId={null}
            activeTool={props.activeTool}
            onSelectTool={props.onSelectTool ?? vi.fn()}
            onDone={props.onDone ?? vi.fn()}
            canPickElements
            showKeyHints
            hint="Click an element to add feedback for the agent."
            hintIsError={false}
            annotateActions={null}
            grabCopyDone={false}
            grabPicked={props.grabPicked ?? false}
            grabCanScreenshot={props.grabPicked ?? false}
            onGrabCopy={props.onGrabCopy ?? vi.fn()}
            onGrabScreenshot={props.onGrabScreenshot ?? vi.fn()}
            onDrawSlotChange={vi.fn()}
            onDrawCompactChange={vi.fn()}
          />
        ) : null}
      </div>
    </TooltipProvider>
  )
}

describe('BrowserAnnotateToolPalette', () => {
  it('shows Annotate, Grab and Draw as visible tools and switches with a plain click', () => {
    const onSelectTool = vi.fn()
    render(<Harness activeTool="annotate" onSelectTool={onSelectTool} />)

    expect(screen.getByRole('button', { name: 'Annotate' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Grab' }))
    expect(onSelectTool).toHaveBeenLastCalledWith('copy')
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }))
    expect(onSelectTool).toHaveBeenLastCalledWith('draw')
  })

  it("offers Grab's Copy and Screenshot for the picked element, and Done exits", () => {
    const onGrabCopy = vi.fn()
    const onGrabScreenshot = vi.fn()
    const onDone = vi.fn()
    render(
      <Harness
        activeTool="copy"
        grabPicked
        onGrabCopy={onGrabCopy}
        onGrabScreenshot={onGrabScreenshot}
        onDone={onDone}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(onGrabCopy).toHaveBeenCalledTimes(1)
    expect(onGrabScreenshot).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('keeps Copy and Screenshot unavailable until an element is picked', () => {
    render(<Harness activeTool="copy" />)

    expect(screen.getByRole('button', { name: 'Copy' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Screenshot' }).hasAttribute('disabled')).toBe(true)
  })

  it('moves focus between tools with the arrow keys without switching tool', () => {
    const onSelectTool = vi.fn()
    render(<Harness activeTool="draw" onSelectTool={onSelectTool} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Draw' }), { key: 'ArrowRight' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Annotate' }))
    expect(onSelectTool).not.toHaveBeenCalled()
  })

  it('moves sideways from the keyboard on its grip, within the page', () => {
    render(<Harness activeTool="annotate" />)
    const grip = screen.getByRole('slider', { name: 'Move toolbar' })
    expect(grip.getAttribute('aria-valuetext')).toBe('Centre, 50%')

    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(getAnnotatePaletteRatio()).toBeCloseTo(0.55)
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true })
    expect(getAnnotatePaletteRatio()).toBeCloseTo(0.3)
    fireEvent.keyDown(grip, { key: 'End' })
    expect(getAnnotatePaletteRatio()).toBeCloseTo(1)
    fireEvent.keyDown(grip, { key: 'Home' })
    expect(getAnnotatePaletteRatio()).toBeCloseTo(0)
  })

  it('stays inside the page while dragged past its edge', () => {
    render(<Harness activeTool="annotate" />)
    const grip = screen.getByRole('slider', { name: 'Move toolbar' })
    grip.setPointerCapture = vi.fn()

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 400 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5000, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 5000 })

    expect(getAnnotatePaletteRatio()).toBeCloseTo(1)
  })

  it('fades and lets clicks through while Alt is held, and comes back on release', () => {
    render(<Harness activeTool="annotate" />)
    const palette = screen.getByRole('group', { name: 'Annotate tools' })
    expect(palette.className).toContain('pointer-events-auto')

    fireEvent.keyDown(window, { key: 'Alt' })
    expect(palette.className).toContain('pointer-events-none')

    fireEvent.keyUp(window, { key: 'Alt' })
    expect(palette.className).toContain('pointer-events-auto')
  })
})

// @vitest-environment happy-dom
import { useEffect, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserAnnotateToolPalette } from './BrowserAnnotateToolPalette'
import { setAnnotatePaletteRatio } from './annotate-palette-position-store'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'

beforeEach(() => {
  setAnnotatePaletteRatio(0.5)
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
  canPickElements?: boolean
  unavailableReason?: string
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
            ownerPageId="sample-page"
            activeTool={props.activeTool}
            onSelectTool={props.onSelectTool ?? vi.fn()}
            onDone={props.onDone ?? vi.fn()}
            canPickElements={props.canPickElements ?? true}
            unavailableReason={props.unavailableReason}
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
            onDrawDensityChange={vi.fn()}
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

  it('marks the other tools unavailable on a failed load while Done stays usable', () => {
    render(
      <Harness activeTool="annotate" canPickElements={false} unavailableReason="Page didn't load" />
    )

    expect(screen.getByRole('button', { name: 'Grab' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Draw' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Annotate' }).hasAttribute('aria-disabled')).toBe(
      false
    )
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps Copy and Screenshot unavailable until an element is picked', () => {
    render(<Harness activeTool="copy" />)

    expect(screen.getByRole('button', { name: 'Copy' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Screenshot' }).hasAttribute('disabled')).toBe(true)
  })

  it('moves focus to the next tool button with the arrow key, wrapping at the end', () => {
    render(<Harness activeTool="draw" />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Draw' }), { key: 'ArrowRight' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Annotate' }))
  })
})

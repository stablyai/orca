// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import DiagramViewerModal from './DiagramViewerModal'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><text>A</text></svg>'

function Host(): React.JSX.Element {
  const activeModal = useAppStore((s) => s.activeModal)
  return (
    <TooltipProvider>
      <button
        type="button"
        onClick={() => useAppStore.getState().openModal('diagram-viewer', { svg })}
      >
        open
      </button>
      {activeModal === 'diagram-viewer' ? <DiagramViewerModal /> : null}
    </TooltipProvider>
  )
}

function sizeCanvas(): HTMLElement {
  const canvas = screen.getByTestId('pan-zoom-image-canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 1000 })
  Object.defineProperty(canvas, 'clientHeight', { value: 600 })
  act(() => resizeObservers.forEach((notify) => notify()))
  return canvas
}

const resizeObservers = new Set<() => void>()

beforeEach(() => {
  resizeObservers.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly notify: () => void
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this)
      }
      observe(): void {
        resizeObservers.add(this.notify)
      }
      unobserve(): void {}
      disconnect(): void {
        resizeObservers.delete(this.notify)
      }
    }
  )
  URL.createObjectURL = vi.fn(() => 'blob:diagram')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  act(() => useAppStore.getState().closeModal())
  vi.unstubAllGlobals()
})

describe('DiagramViewerModal', () => {
  it('shows the diagram fitted and centered, and Escape returns focus to the opener', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'open' })
    await user.click(opener)

    expect(screen.getByRole('dialog', { name: 'Diagram' })).toBeInTheDocument()
    sizeCanvas()
    const image = screen.getByRole('img', { name: 'Diagram' })
    expect(image).toHaveAttribute('src', 'blob:diagram')
    expect(image.style.width).toBe('400px')
    expect(image.style.transform).toBe('translate(300px, 200px)')
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toBeDisabled()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagram')
  })

  it('zooms from the toolbar, pans on drag, and fits again', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    const canvas = sizeCanvas()
    const image = screen.getByRole('img', { name: 'Diagram' })

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.width).toBe('500px')
    expect(image.style.transform).toBe('translate(250px, 175px)')

    canvas.setPointerCapture = vi.fn()
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    // Two moves before a render must both count.
    act(() => {
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 95 })
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 140, clientY: 90 })
    })
    fireEvent.pointerCancel(canvas, { pointerId: 1 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 500, clientY: 500 })
    expect(image.style.transform).toBe('translate(290px, 165px)')

    await user.click(screen.getByRole('button', { name: 'Fit to screen' }))
    expect(image.style.width).toBe('400px')
    expect(image.style.transform).toBe('translate(300px, 200px)')
  })

  it('closes only the viewer when opened from inside another dialog', async () => {
    const user = userEvent.setup()
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Pull request</DialogTitle>
          <Host />
        </DialogContent>
      </Dialog>
    )
    const opener = screen.getByRole('button', { name: 'open' })
    await user.click(opener)
    expect(screen.getByRole('dialog', { name: 'Diagram' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Diagram' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Pull request' })).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('re-serializes the HTML-serialized sanitizer output as an XML image document', async () => {
    // Chromium’s sanitizer emits &nbsp; for U+00A0; happy-dom preserves the entity during XML serialization, so assert successful reparsing.
    const sanitized = '<svg viewBox="0 0 400 200"><text>User&nbsp;A</text></svg>'
    render(<Host />)
    act(() => useAppStore.getState().openModal('diagram-viewer', { svg: sanitized }))
    sizeCanvas()

    expect(screen.getByRole('img', { name: 'Diagram' }).style.width).toBe('400px')
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0]
    const xml = blob instanceof Blob ? await blob.text() : ''
    expect(xml).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('pans by the wheel distance whatever unit the device reports', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    const canvas = sizeCanvas()
    const image = screen.getByRole('img', { name: 'Diagram' })

    fireEvent.wheel(canvas, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(image.style.transform).toBe('translate(300px, 152px)')
  })

  it('leaves focus alone when another modal replaced the viewer', async () => {
    const user = userEvent.setup()
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'open' })
    await user.click(opener)
    act(() => useAppStore.getState().openModal('quick-open'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).not.toBe(opener)
  })
})

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandableMarkdownImage } from './MarkdownImageLightbox'
import { isMarkdownImageLightboxOpen } from './markdown-image-lightbox-state'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ExpandableMarkdownImage', () => {
  it('opens a viewport lightbox on click and closes on Escape without leaking the key', () => {
    vi.useFakeTimers()
    const parentEscape = vi.fn()
    document.addEventListener('keydown', parentEscape)

    render(
      <ExpandableMarkdownImage
        src="data:image/png;base64,abc"
        alt="shot.png"
        className="max-h-96"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeTruthy()
    expect(isMarkdownImageLightboxOpen()).toBe(true)
    expect(screen.getAllByAltText('shot.png').length).toBeGreaterThanOrEqual(2)

    fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    // Why: sheet listeners must not see Esc while the lightbox owns it.
    expect(parentEscape).not.toHaveBeenCalled()
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull()
    expect(isMarkdownImageLightboxOpen()).toBe(false)

    document.removeEventListener('keydown', parentEscape)
  })

  it('closes on the close button pointer press without synchronous unmount click-through', () => {
    vi.useFakeTimers()
    render(<ExpandableMarkdownImage src="data:image/png;base64,abc" alt="ui.png" />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    expect(isMarkdownImageLightboxOpen()).toBe(true)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close' }))
    // Still mounted until the deferred close tick (avoids sheet dismiss).
    expect(screen.getByRole('dialog', { name: 'ui.png' })).toBeTruthy()
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.queryByRole('dialog', { name: 'ui.png' })).toBeNull()
    expect(isMarkdownImageLightboxOpen()).toBe(false)
  })
  it('keeps the parent issue drawer open after Escape and close-button dismissal', () => {
    vi.useFakeTimers()
    const onOpenChange = vi.fn()

    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Jira issue</SheetTitle>
          <ExpandableMarkdownImage src="data:image/png;base64,abc" alt="jira.png" />
        </SheetContent>
      </Sheet>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true })
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByText('Jira issue')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getByText('Jira issue')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandableMarkdownImage } from './MarkdownImageLightbox'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

afterEach(() => {
  cleanup()
})

describe('ExpandableMarkdownImage', () => {
  it('opens an accessible dialog, traps focus, and restores focus after Escape', async () => {
    const user = userEvent.setup()
    render(
      <ExpandableMarkdownImage
        src="data:image/png;base64,abc"
        alt="shot.png"
        className="max-h-96"
      />
    )

    const trigger = screen.getByRole('button', { name: 'Expand image' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeTruthy()
    expect(screen.getAllByAltText('shot.png').length).toBeGreaterThanOrEqual(2)
    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(closeButton)

    await user.tab()
    expect(document.activeElement).toBe(closeButton)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'shot.png' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('closes from the dialog close button', () => {
    render(<ExpandableMarkdownImage src="data:image/png;base64,abc" alt="ui.png" />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'ui.png' })).toBeNull()
  })

  it('keeps the parent issue drawer open after Escape and close-button dismissal', () => {
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
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'jira.png' }), { key: 'Escape' })
    expect(screen.getByText('Jira issue')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByText('Jira issue')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type MouseEvent as ReactMouseEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpandableMarkdownImage } from './MarkdownImageLightbox'
import CommentMarkdown from './CommentMarkdown'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

afterEach(() => {
  cleanup()
})

describe('ExpandableMarkdownImage', () => {
  it('opens an accessible dialog and restores focus after Escape', async () => {
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
    const dialog = screen.getByRole('dialog', { name: 'shot.png' })
    expect(screen.getAllByAltText('shot.png').length).toBeGreaterThanOrEqual(2)
    expect(document.activeElement).toBe(dialog)

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

  it('keeps managing its own open state when a caller observes changes', () => {
    const onOpenChange = vi.fn()
    render(<ExpandableMarkdownImage src="blob:shot" alt="shot.png" onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeTruthy()
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
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

it.each([undefined, () => {}])(
  'scales percentage height after loading in either document image renderer',
  (onLinkClick) => {
    const src = '/uploads/0123456789abcdef0123456789abcdef/screen.png'
    render(
      <CommentMarkdown
        variant="document"
        content={`![percent](${src}){height=50%}`}
        gitlabImageSources={{ [src]: 'data:image/png;base64,abc' }}
        onLinkClick={onLinkClick}
      />
    )
    const image = screen.getByAltText('percent')
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 })
    fireEvent.load(image)
    expect(image.style.height).toBe('200px')
    expect(image.getAttribute('height')).toBeNull()
  }
)

it('forwards preview failures while retaining percentage dimensions', () => {
  const onError = vi.fn()
  render(
    <ExpandableMarkdownImage
      src="data:image/png;base64,abc"
      alt="preview"
      width="75%"
      height="50%"
      onError={onError}
    />
  )
  const image = screen.getByAltText('preview')
  expect(screen.getByRole('button', { name: 'Expand image' }).style.width).toBe('75%')
  expect(image.style.width).toBe('100%')
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 })
  fireEvent.load(image)
  expect(image.style.height).toBe('200px')
  fireEvent.error(image)
  expect(onError).toHaveBeenCalledOnce()
})

it('opens the authenticated GitLab bytes in the shared pan and zoom dialog', () => {
  const src = '/uploads/0123456789abcdef0123456789abcdef/screen.png'
  const data = 'data:image/png;base64,abc'
  render(
    <CommentMarkdown
      variant="document"
      content={`![private](${src}){width=75%}`}
      gitlabImageSources={{ [src]: data }}
    />
  )
  expect(screen.getByRole('button', { name: 'Expand image' }).style.width).toBe('75%')
  fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
  const dialog = screen.getByRole('dialog', { name: 'private' })
  expect(within(dialog).getByAltText('private').getAttribute('src')).toBe(data)
  expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog', { name: 'private' })).toBeNull()
})

it('retains controlled lightbox behavior and trigger events for sized previews', () => {
  const onOpenChange = vi.fn()
  const onAuxClick = vi.fn()
  const onClick = vi.fn((event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault())
  const { rerender } = render(
    <ExpandableMarkdownImage
      src="data:image/png;base64,abc"
      alt="controlled preview"
      width="75%"
      height="50%"
      open={false}
      onOpenChange={onOpenChange}
      triggerLabel="Open attachment"
      triggerAttributes={{ 'data-attachment': 'private' }}
      onClick={onClick}
      onAuxClick={onAuxClick}
    />
  )
  const trigger = screen.getByRole('button', { name: 'Open attachment' })
  expect(trigger.style.width).toBe('75%')
  expect(trigger.getAttribute('data-attachment')).toBe('private')
  fireEvent.click(trigger)
  expect(onClick).toHaveBeenCalledOnce()
  expect(onOpenChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent(trigger, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
  expect(onAuxClick).toHaveBeenCalledOnce()

  rerender(
    <ExpandableMarkdownImage
      src="data:image/png;base64,abc"
      alt="controlled preview"
      width="75%"
      height="50%"
      open
      onOpenChange={onOpenChange}
    />
  )
  const dialog = screen.getByRole('dialog', { name: 'controlled preview' })
  expect(within(dialog).getByAltText('controlled preview').getAttribute('src')).toBe(
    'data:image/png;base64,abc'
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it('keeps a missing-source placeholder until a sized preview becomes available', () => {
  const { rerender } = render(
    <ExpandableMarkdownImage src={undefined} alt="pending attachment" width="75%" />
  )
  expect(screen.getByText('pending attachment')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()

  rerender(
    <ExpandableMarkdownImage src="data:image/png;base64,abc" alt="pending attachment" width="75%" />
  )
  expect(screen.getByRole('button', { name: 'Expand image' }).style.width).toBe('75%')
  expect(screen.getByAltText('pending attachment').style.width).toBe('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
  expect(screen.getByRole('dialog', { name: 'pending attachment' })).toBeTruthy()
})

it('preserves a trigger footprint and load notifications alongside GitLab dimensions', () => {
  const triggerRef = createRef<HTMLButtonElement>()
  const onLoad = vi.fn()
  const { rerender } = render(
    <ExpandableMarkdownImage
      src={undefined}
      alt="loading preview"
      triggerRef={triggerRef}
      triggerStyle={{ width: 320, aspectRatio: '2 / 1' }}
    />
  )
  expect(triggerRef.current).toBe(screen.getByRole('button', { name: 'Expand image' }))
  expect(triggerRef.current?.style.width).toBe('320px')
  expect(triggerRef.current?.style.aspectRatio).toBe('2 / 1')

  rerender(
    <ExpandableMarkdownImage
      src="data:image/png;base64,abc"
      alt="loading preview"
      width="75%"
      height="50%"
      triggerRef={triggerRef}
      triggerStyle={{ aspectRatio: '2 / 1' }}
      onLoad={onLoad}
    />
  )
  const image = screen.getByAltText('loading preview')
  expect(triggerRef.current?.style.width).toBe('75%')
  expect(triggerRef.current?.style.aspectRatio).toBe('2 / 1')
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 })
  fireEvent.load(image)
  expect(image.style.height).toBe('200px')
  expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ target: image }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
  expect(screen.getByRole('dialog', { name: 'loading preview' })).toBeTruthy()
})

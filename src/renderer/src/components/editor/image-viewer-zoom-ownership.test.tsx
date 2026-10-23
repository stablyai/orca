// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'
import ImageDiffViewer from './ImageDiffViewer'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { requestViewerZoom } from './viewer-zoom-request'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./PdfViewer', () => ({ default: () => null }))

// 1x1 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

afterEach(cleanup)

function renderImage(isCommandOwner: boolean, layout: 'fill' | 'intrinsic' = 'fill'): void {
  render(
    <EditorCommandOwnerContext value={isCommandOwner}>
      <ImageViewer content={PNG} filePath="/repo/shot.png" mimeType="image/png" layout={layout} />
    </EditorCommandOwnerContext>
  )
}

function zoom(direction: 'in' | 'out' | 'reset'): boolean {
  let claimed = false
  act(() => {
    claimed = requestViewerZoom(direction)
  })
  return claimed
}

describe('ImageViewer app zoom ownership', () => {
  it('zooms the image in the command-owning editor pane', () => {
    renderImage(true)

    expect(zoom('in')).toBe(true)
    expect(screen.getByText('125%')).toBeTruthy()

    zoom('in')
    zoom('out')
    expect(screen.getByText('125%')).toBeTruthy()

    zoom('reset')
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zooms the open popup instead of the hidden inline image', () => {
    renderImage(true)
    fireEvent.click(screen.getByTitle('Open image in popup'))

    zoom('in')

    expect(within(screen.getByRole('dialog')).getByText('125%')).toBeTruthy()
    expect(screen.getAllByText('100%')).toHaveLength(1)
  })

  it('releases zoom ownership when focus moves and removes its listener on unmount', () => {
    const image = (ownsCommands: boolean) => (
      <EditorCommandOwnerContext value={ownsCommands}>
        <ImageViewer content={PNG} filePath="/repo/shot.png" mimeType="image/png" />
      </EditorCommandOwnerContext>
    )
    const viewer = render(image(true))
    expect(zoom('in')).toBe(true)

    viewer.rerender(image(false))
    expect(zoom('in')).toBe(false)
    expect(screen.getByText('125%')).toBeTruthy()

    viewer.rerender(image(true))
    expect(zoom('in')).toBe(true)
    expect(screen.getByText('156%')).toBeTruthy()

    viewer.unmount()
    expect(zoom('in')).toBe(false)
  })

  it('zooms a diff popup without changing the other image behind it', () => {
    render(
      <EditorCommandOwnerContext value={true}>
        <ImageDiffViewer
          originalContent={PNG}
          modifiedContent={PNG}
          filePath="/repo/shot.png"
          mimeType="image/png"
          sideBySide={true}
        />
      </EditorCommandOwnerContext>
    )
    fireEvent.click(screen.getAllByTitle('Open image in popup')[1])

    expect(zoom('in')).toBe(true)
    expect(within(screen.getByRole('dialog')).getByText('125%')).toBeTruthy()
    expect(screen.getAllByText('100%')).toHaveLength(2)

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(zoom('in')).toBe(true)
    expect(screen.getAllByText('125%')).toHaveLength(2)
  })

  it('routes between main and floating image owners using DOM focus', () => {
    const image = (filePath: string) => (
      <EditorCommandOwnerContext value={true}>
        <ImageViewer content={PNG} filePath={filePath} mimeType="image/png" />
      </EditorCommandOwnerContext>
    )
    render(
      <>
        <div data-testid="main" tabIndex={-1}>
          {image('/repo/main.png')}
        </div>
        <div data-testid="floating" data-floating-terminal-panel="" tabIndex={-1}>
          {image('/repo/floating.png')}
        </div>
      </>
    )
    const main = screen.getByTestId('main')
    const floating = screen.getByTestId('floating')

    floating.focus()
    expect(zoom('in')).toBe(true)
    expect(within(floating).getByText('125%')).toBeTruthy()
    expect(within(main).getByText('100%')).toBeTruthy()

    main.focus()
    expect(zoom('in')).toBe(true)
    expect(within(main).getByText('125%')).toBeTruthy()
    expect(within(floating).getByText('125%')).toBeTruthy()

    floating.focus()
    fireEvent.click(within(floating).getByTitle('Open image in popup'))
    expect(zoom('in')).toBe(true)
    expect(within(screen.getByRole('dialog')).getByText('156%')).toBeTruthy()
    expect(within(main).getByText('125%')).toBeTruthy()
    expect(within(floating).getByText('125%')).toBeTruthy()
  })

  it.each([true, false])(
    'leaves text zoom unclaimed across surfaces (floating image: %s)',
    (floating) => {
      render(
        <>
          <div data-floating-terminal-panel={floating ? '' : undefined}>
            <EditorCommandOwnerContext value={true}>
              <ImageViewer content={PNG} filePath="/repo/shot.png" mimeType="image/png" />
            </EditorCommandOwnerContext>
          </div>
          <div data-floating-terminal-panel={floating ? undefined : ''}>
            <textarea aria-label="Other editor" />
          </div>
        </>
      )
      screen.getByRole('textbox', { name: 'Other editor' }).focus()

      expect(zoom('in')).toBe(false)
      expect(screen.getByText('100%')).toBeTruthy()
    }
  )

  it('leaves zoom to the focused pane when this image is in an unfocused split or hidden worktree', () => {
    renderImage(false)

    expect(zoom('in')).toBe(false)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('leaves editor font zoom alone in a combined diff of intrinsic images', () => {
    renderImage(true, 'intrinsic')

    expect(zoom('in')).toBe(false)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('zooms the popup a combined-diff image opened', () => {
    renderImage(true, 'intrinsic')
    fireEvent.click(screen.getByTitle('Open image in popup'))

    expect(zoom('in')).toBe(true)
    expect(within(screen.getByRole('dialog')).getByText('125%')).toBeTruthy()
    expect(screen.getAllByText('100%')).toHaveLength(1)
  })
})

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'
import ImageDiffViewer from './ImageDiffViewer'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { requestViewerZoom } from './viewer-zoom-request'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./PdfViewer', () => ({ default: () => null }))

// 1x1 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// Browsers report the initial size on observe(); happy-dom never does.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        this.callback([], this)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

  it('zooms both sides of a diff together', () => {
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

  it('keeps a zoom that arrives before the image has loaded', () => {
    render(
      <EditorCommandOwnerContext value={true}>
        <ImageViewer
          src="orca-media://file/t?revision=1"
          filePath="/repo/shot.png"
          mimeType="image/png"
        />
      </EditorCommandOwnerContext>
    )
    expect(zoom('in')).toBe(true)
    const image = screen.getByRole('img', { name: 'shot.png' })
    Object.defineProperties(image, {
      naturalWidth: { value: 4000 },
      naturalHeight: { value: 3000 }
    })
    fireEvent.load(image)
    expect(screen.getByText('125%')).toBeTruthy()
  })

  it('keeps the zoom when the same file is reminted under a new revision', () => {
    const image = (revision: number) => (
      <EditorCommandOwnerContext value={true}>
        <ImageViewer
          src={`orca-media://file/t?revision=${revision}`}
          filePath="/repo/shot.png"
          mimeType="image/png"
        />
      </EditorCommandOwnerContext>
    )
    const viewer = render(image(1))
    const loaded = screen.getByRole('img', { name: 'shot.png' })
    Object.defineProperties(loaded, { naturalWidth: { value: 400 }, naturalHeight: { value: 300 } })
    fireEvent.load(loaded)
    zoom('in')
    expect(screen.getByText('125%')).toBeTruthy()

    viewer.rerender(image(2))
    expect(screen.getByText('125%')).toBeTruthy()
  })

  it('leaves zoom to the focused pane when this image is in an unfocused split or hidden worktree', () => {
    renderImage(false)

    expect(zoom('in')).toBe(false)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('leaves editor font zoom alone in a combined diff until an image is expanded', () => {
    renderImage(true, 'intrinsic')
    expect(zoom('in')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Expand image' }))
    const expanded = within(screen.getByRole('dialog')).getByRole('img', { name: 'shot.png' })
    const fitted = expanded.style.width
    expect(zoom('in')).toBe(true)
    expect(expanded.style.width).not.toBe(fitted)
  })
})

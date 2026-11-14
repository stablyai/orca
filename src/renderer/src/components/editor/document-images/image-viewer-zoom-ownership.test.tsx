// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'

import { EditorCommandOwnerContext } from '../commands/editor-command-owner-context'
import { requestViewerZoom } from '../viewer-viewport/viewer-zoom-request'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../pdf/PdfViewer', () => ({ default: () => null }))

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

function zoom(direction: 'in' | 'out' | 'reset'): boolean {
  let claimed = false
  act(() => {
    claimed = requestViewerZoom(direction)
  })
  return claimed
}

describe('ImageViewer app zoom ownership', () => {
  it('releases zoom ownership when command ownership changes and removes its listener on unmount', () => {
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
})

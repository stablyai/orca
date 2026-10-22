// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImageViewer from './ImageViewer'
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
})

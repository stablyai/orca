// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchAppMenuSelectionAction } from '@/lib/app-menu-selection-actions'
import { useImageViewerCopy } from './use-image-viewer-copy'

const copyImageToClipboard = vi.hoisted(() => vi.fn<() => Promise<void>>())
const platform = vi.hoisted((): { value: NodeJS.Platform } => ({ value: 'darwin' }))

vi.mock('@/lib/copy-image-to-clipboard', () => ({ copyImageToClipboard }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platform.value }))

function Viewer({ label }: { label: string }): React.JSX.Element {
  const { copyScopeProps } = useImageViewerCopy(`data:image/png;base64,${label}`)
  return (
    <div {...copyScopeProps} tabIndex={-1} aria-label={label}>
      <span>{label} caption</span>
    </div>
  )
}

function copyFromAppMenu(): boolean {
  let handled = false
  act(() => {
    handled = dispatchAppMenuSelectionAction('copy')
  })
  return handled
}

beforeEach(() => {
  platform.value = 'darwin'
  copyImageToClipboard.mockReset()
  copyImageToClipboard.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

describe('useImageViewerCopy', () => {
  it('copies only the focused viewer when two are mounted', () => {
    render(
      <>
        <Viewer label="original" />
        <Viewer label="modified" />
      </>
    )
    screen.getByLabelText('modified').focus()

    expect(copyFromAppMenu()).toBe(true)
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1)
  })

  it('leaves the app menu copy alone when focus is outside every viewer', () => {
    render(
      <>
        <Viewer label="original" />
        <button type="button">Outside</button>
      </>
    )
    screen.getByText('Outside').focus()

    expect(copyFromAppMenu()).toBe(false)
    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })

  it('lets a text selection win over the image', () => {
    render(<Viewer label="original" />)
    screen.getByLabelText('original').focus()
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('original caption'))
    window.getSelection()?.addRange(range)

    expect(copyFromAppMenu()).toBe(false)
    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })

  it('ignores select-all', () => {
    render(<Viewer label="original" />)
    screen.getByLabelText('original').focus()

    let handled = true
    act(() => {
      handled = dispatchAppMenuSelectionAction('select-all')
    })
    expect(handled).toBe(false)
    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })

  it('copies on Ctrl+C off macOS, by physical key and without repeats', () => {
    platform.value = 'linux'
    render(<Viewer label="original" />)
    const viewer = screen.getByLabelText('original')

    fireEvent.keyDown(viewer, { key: 'с', code: 'KeyC', ctrlKey: true })
    fireEvent.keyDown(viewer, { key: 'c', code: 'KeyC', ctrlKey: true, repeat: true })
    fireEvent.keyDown(viewer, { key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })

    expect(copyImageToClipboard).toHaveBeenCalledTimes(1)
  })

  it('leaves keydown to the app menu on macOS', () => {
    render(<Viewer label="original" />)

    fireEvent.keyDown(screen.getByLabelText('original'), { key: 'c', code: 'KeyC', ctrlKey: true })

    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })

  it('skips a new copy while one is still running', async () => {
    let finish: () => void = () => {}
    copyImageToClipboard.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    render(<Viewer label="original" />)
    screen.getByLabelText('original').focus()

    copyFromAppMenu()
    copyFromAppMenu()
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    copyFromAppMenu()
    expect(copyImageToClipboard).toHaveBeenCalledTimes(2)
  })
})

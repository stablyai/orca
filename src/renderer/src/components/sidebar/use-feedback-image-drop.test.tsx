// @vitest-environment happy-dom

import { act } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_INTERNAL_FILE_DRAG_TYPE } from '../../../../shared/native-file-drop'
import { installOsFileDropCancellationGuard } from '../../lib/os-file-drop-cancellation-guard'
import { useFeedbackImageDrop } from './use-feedback-image-drop'

let container: HTMLDivElement
let root: Root
let disposeGuard: () => void
let unclaimedDropSpy: ReturnType<typeof vi.fn<(event: Event) => void>>
const showNotice = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: Object.assign(showNotice, {
    error: showNotice,
    warning: showNotice,
    info: showNotice,
    success: showNotice,
    message: showNotice
  })
}))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  showNotice.mockClear()
  disposeGuard = installOsFileDropCancellationGuard()
  unclaimedDropSpy = vi.fn()
  document.addEventListener('drop', unclaimedDropSpy)
})

afterEach(() => {
  disposeGuard()
  document.removeEventListener('drop', unclaimedDropSpy)
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

function Harness({
  open,
  onAddFiles
}: {
  open: boolean
  onAddFiles: (files: readonly File[]) => void
}): React.JSX.Element {
  const { isDragActive, contentRef, dragHandlers } = useFeedbackImageDrop(open, onAddFiles)
  return (
    <div ref={contentRef} data-testid="dialog" data-drag-active={isDragActive} {...dragHandlers}>
      <span data-testid="child">child</span>
    </div>
  )
}

async function renderHarness(
  open: boolean,
  onAddFiles: (files: readonly File[]) => void
): Promise<void> {
  await act(async () => {
    root.render(<Harness open={open} onAddFiles={onAddFiles} />)
  })
}

function dragEvent(type: string, files: File[], types: string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types } })
  return event
}

function pngFile(name = 'shot.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function dialogChild(): HTMLElement {
  const child = container.querySelector<HTMLElement>('[data-testid="child"]')
  if (!child) {
    throw new Error('harness child missing')
  }
  return child
}

describe('useFeedbackImageDrop', () => {
  it('claims an image dropped on the dialog and attaches it once', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    expect(container.querySelector('[data-os-file-drop-owner]')).not.toBeNull()
    const event = dragEvent('drop', [pngFile()])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(onAddFiles).toHaveBeenCalledTimes(1)
    expect(onAddFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['shot.png'])
    expect(event.defaultPrevented).toBe(true)
    expect(unclaimedDropSpy).not.toHaveBeenCalled()
  })

  it('silently cancels drops outside the dialog and clears the hover state', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    act(() => {
      dialogChild().dispatchEvent(dragEvent('dragenter', []))
    })
    expect(container.querySelector('[data-drag-active="true"]')).not.toBeNull()
    const event = dragEvent('drop', [pngFile()])
    act(() => {
      outside.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(event).toHaveProperty('dataTransfer.dropEffect', 'none')
    expect(onAddFiles).not.toHaveBeenCalled()
    expect(showNotice).not.toHaveBeenCalled()
    expect(container.querySelector('[data-drag-active="true"]')).toBeNull()
  })

  it('claims non-image drops so they cannot open in the editor behind the dialog', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    const event = dragEvent('drop', [new File(['x'], 'notes.txt', { type: 'text/plain' })])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(onAddFiles).not.toHaveBeenCalled()
    // A refused file still cancels browser navigation.
    expect(event.defaultPrevented).toBe(true)
    expect(unclaimedDropSpy).not.toHaveBeenCalled()
  })

  it('stops listening once the dialog is closed', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)
    await renderHarness(false, onAddFiles)
    expect(container.querySelector('[data-os-file-drop-owner]')).toBeNull()

    const event = dragEvent('drop', [pngFile()])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(event).toHaveProperty('dataTransfer.dropEffect', 'none')
    expect(onAddFiles).not.toHaveBeenCalled()
    expect(showNotice).not.toHaveBeenCalled()
  })

  it('claims dragover so the document guard preserves the accepted copy cursor', async () => {
    await renderHarness(true, vi.fn())

    const event = dragEvent('dragover', [])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(event).toHaveProperty('dataTransfer.dropEffect', 'copy')
  })

  it('leaves in-app drags alone on dragover', async () => {
    await renderHarness(true, vi.fn())

    const event = dragEvent('dragover', [], ['Files', ORCA_INTERNAL_FILE_DRAG_TYPE])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(false)
  })

  it('keeps a web feedback screenshot accepted with the document guard and attaches it once', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)
    expect(container.querySelector('[data-os-file-drop-owner]')).not.toBeNull()
    const image = pngFile()
    const hover = dragEvent('dragover', [])
    act(() => {
      dialogChild().dispatchEvent(hover)
    })
    expect(hover.defaultPrevented).toBe(true)
    expect(hover).toHaveProperty('dataTransfer.dropEffect', 'copy')
    const drop = dragEvent('drop', [image])
    act(() => {
      dialogChild().dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(onAddFiles).toHaveBeenCalledExactlyOnceWith([image])

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    const refusedHover = dragEvent('dragover', [])
    act(() => {
      outside.dispatchEvent(refusedHover)
    })
    expect(refusedHover.defaultPrevented).toBe(true)
    expect(refusedHover).toHaveProperty('dataTransfer.dropEffect', 'none')
    const refusedDrop = dragEvent('drop', [image])
    act(() => {
      outside.dispatchEvent(refusedDrop)
    })
    expect(refusedDrop.defaultPrevented).toBe(true)
    expect(refusedDrop).toHaveProperty('dataTransfer.dropEffect', 'none')
    expect(onAddFiles).toHaveBeenCalledOnce()
    expect(showNotice).not.toHaveBeenCalled()
  })

  it('highlights from the advertised drag types, which is all a dragenter exposes', async () => {
    await renderHarness(true, vi.fn())
    const dialog = container.querySelector<HTMLElement>('[data-testid="dialog"]')!

    // Why: DataTransfer.files is empty until drop; only `types` is populated.
    act(() => {
      dialogChild().dispatchEvent(dragEvent('dragenter', []))
    })
    expect(dialog.dataset.dragActive).toBe('true')

    act(() => {
      dialogChild().dispatchEvent(dragEvent('dragleave', []))
    })
    expect(dialog.dataset.dragActive).toBe('false')
  })
})

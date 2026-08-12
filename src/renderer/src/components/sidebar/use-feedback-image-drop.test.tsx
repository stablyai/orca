// @vitest-environment happy-dom

/**
 * Native file drops never reach React in this app: preload claims them on
 * document capture and routes the paths to the editor. These tests pin the
 * window-capture interception that keeps a screenshot dropped on the feedback
 * dialog from being swallowed by that lane.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_INTERNAL_FILE_DRAG_TYPE } from '../../../../shared/native-file-drop'
import { useFeedbackImageDrop } from './use-feedback-image-drop'

let container: HTMLDivElement
let root: Root
let preloadDropSpy: ReturnType<typeof vi.fn<(event: Event) => void>>

function preloadDropListener(event: Event): void {
  preloadDropSpy(event)
  // Why: preload consumes the gesture, which is why React's onDrop never runs.
  event.preventDefault()
  event.stopPropagation()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  preloadDropSpy = vi.fn()
  // Registered before the hook mounts, exactly like preload's document listener.
  document.addEventListener('drop', preloadDropListener, true)
})

afterEach(() => {
  document.removeEventListener('drop', preloadDropListener, true)
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
  Object.defineProperty(event, 'dataTransfer', { value: { files, types } })
  return event
}

function pngFile(name = 'shot.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function dialogChild(): HTMLElement {
  const child = container.querySelector('[data-testid="child"]')
  if (!child) {
    throw new Error('harness child missing')
  }
  return child as HTMLElement
}

describe('useFeedbackImageDrop', () => {
  it('claims an image dropped on the dialog before preload can route it away', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    const event = dragEvent('drop', [pngFile()])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(onAddFiles).toHaveBeenCalledTimes(1)
    expect(onAddFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(['shot.png'])
    expect(event.defaultPrevented).toBe(true)
    expect(preloadDropSpy).not.toHaveBeenCalled()
  })

  it('leaves drops outside the dialog to the existing native lane', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    act(() => {
      outside.dispatchEvent(dragEvent('drop', [pngFile()]))
    })

    expect(onAddFiles).not.toHaveBeenCalled()
    expect(preloadDropSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores non-image drops so they keep their existing behavior', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)

    const event = dragEvent('drop', [new File(['x'], 'notes.txt', { type: 'text/plain' })])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(onAddFiles).not.toHaveBeenCalled()
    expect(preloadDropSpy).toHaveBeenCalledTimes(1)
    // Why: dragover accepted the drag, so an uncancelled drop navigates the web
    // client to the file; preload still gets it because propagation continues.
    expect(event.defaultPrevented).toBe(true)
  })

  it('stops listening once the dialog is closed', async () => {
    const onAddFiles = vi.fn()
    await renderHarness(true, onAddFiles)
    await renderHarness(false, onAddFiles)

    act(() => {
      dialogChild().dispatchEvent(dragEvent('drop', [pngFile()]))
    })

    expect(onAddFiles).not.toHaveBeenCalled()
    expect(preloadDropSpy).toHaveBeenCalledTimes(1)
  })

  // Why: only preload preventDefaults dragover, and the web client has no
  // preload — without this the browser rejects the drop and opens the file.
  it('accepts the drag on dragover so the drop can fire without preload', async () => {
    await renderHarness(true, vi.fn())

    const event = dragEvent('dragover', [])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect((event as DragEvent).dataTransfer?.dropEffect).toBe('copy')
  })

  it('leaves in-app drags alone on dragover', async () => {
    await renderHarness(true, vi.fn())

    const event = dragEvent('dragover', [], ['Files', ORCA_INTERNAL_FILE_DRAG_TYPE])
    act(() => {
      dialogChild().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(false)
  })

  it('highlights from the advertised drag types, which is all a dragenter exposes', async () => {
    await renderHarness(true, vi.fn())
    const dialog = container.querySelector('[data-testid="dialog"]') as HTMLElement

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

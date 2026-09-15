// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import { nativeChatPaneDragKind } from './native-chat-pane-file-drop'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const OVERLAY = '[data-native-chat-drop-overlay="true"]'

const IGNORE_DRAG = (): void => {}

class DropDataTransfer {
  dropEffect = 'none'
  effectAllowed = 'all'
  private readonly data = new Map<string, string>()
  get types(): string[] {
    return [...this.data.keys()]
  }
  setData(type: string, value: string): void {
    this.data.set(type, value)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

function workspaceDrag(): DropDataTransfer {
  const transfer = new DropDataTransfer()
  transfer.setData(WORKSPACE_FILE_PATH_MIME, '/repo/a.ts')

  return transfer
}

function osDrag(): DropDataTransfer {
  const transfer = new DropDataTransfer()
  transfer.setData('Files', '')

  return transfer
}

/** Mounts the composer's claim the way the real composer hook does. */
function ClaimingComposer({
  disabled = false,
  onDragOverCapture = IGNORE_DRAG,
  onDropCapture = IGNORE_DRAG
}: {
  disabled?: boolean
  onDragOverCapture?: (event: React.DragEvent<HTMLDivElement>) => void
  onDropCapture?: (event: React.DragEvent<HTMLDivElement>) => void
}) {
  useNativeChatPaneFileDropClaim({
    scopeKey: 'pane:1',
    disabled,
    onDragOverCapture,
    onDropCapture
  })

  return <div data-testid="composer" />
}

function renderPane(composer: React.ReactNode) {
  const result = render(
    <div data-testid="terminal-behind">
      <NativeChatPaneFileDropSurface className="pane">
        <div data-testid="transcript">transcript</div>
        {composer}
      </NativeChatPaneFileDropSurface>
    </div>
  )

  return { ...result, transcript: screen.getByTestId('transcript') }
}

function fireDrag(
  target: HTMLElement,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  dataTransfer: DropDataTransfer,
  relatedTarget: EventTarget | null = null
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
  act(() => {
    target.dispatchEvent(event)
  })
}

afterEach(cleanup)

describe('nativeChatPaneDragKind', () => {
  it('separates an in-app file drag from an OS file drag', () => {
    expect(nativeChatPaneDragKind(workspaceDrag())).toBe('workspace')
    expect(nativeChatPaneDragKind(osDrag())).toBe('os')
    expect(nativeChatPaneDragKind(new DropDataTransfer())).toBeNull()
  })

  it('reads an OS-looking drag that carries in-app paths as the in-app drag', () => {
    const transfer = osDrag()
    transfer.setData(WORKSPACE_FILE_PATH_MIME, '/repo/a.ts')
    expect(nativeChatPaneDragKind(transfer)).toBe('workspace')
  })
})

describe('NativeChatPaneFileDropSurface', () => {
  it('routes a drop on the transcript to the composer that claimed the pane', () => {
    const onDropCapture = vi.fn()
    const { transcript, container } = renderPane(<ClaimingComposer onDropCapture={onDropCapture} />)

    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()

    fireDrag(transcript, 'drop', workspaceDrag())
    expect(onDropCapture).toHaveBeenCalledTimes(1)
    expect(container.querySelector(OVERLAY)).toBeNull()
  })

  it('publishes the claiming composer as the OS drop route target', () => {
    const { container } = renderPane(<ClaimingComposer />)
    const surface = container.querySelector('.pane')
    expect(surface?.getAttribute('data-native-file-drop-target')).toBe('composer')
    expect(surface?.getAttribute('data-composer-scope-key')).toBe('pane:1')
  })

  it('leaves the pane to the terminal behind it while no composer is mounted', () => {
    const { transcript, container } = renderPane(null)
    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
    expect(container.querySelector('.pane')?.hasAttribute('data-native-file-drop-target')).toBe(
      false
    )
  })

  it('does not invite a drop the guarded composer will refuse', () => {
    const onDragOverCapture = vi.fn()

    const { transcript, container } = renderPane(
      <ClaimingComposer disabled onDragOverCapture={onDragOverCapture} />
    )

    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
    // The composer still answers for the drag: that refusal is what keeps it
    // out of the terminal behind the chat.
    expect(onDragOverCapture).toHaveBeenCalledTimes(1)
  })

  it('shows the overlay for an OS drag without claiming its drop', () => {
    const onDropCapture = vi.fn()
    const { transcript, container } = renderPane(<ClaimingComposer onDropCapture={onDropCapture} />)
    fireDrag(transcript, 'dragover', osDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()
    fireDrag(transcript, 'drop', osDrag())
    expect(onDropCapture).not.toHaveBeenCalled()
  })

  it('clears the active invitation when the composer becomes guarded', () => {
    const pane = (disabled: boolean) => (
      <NativeChatPaneFileDropSurface className="pane">
        <ClaimingComposer disabled={disabled} />
      </NativeChatPaneFileDropSurface>
    )

    const { container, rerender } = render(pane(false))
    fireDrag(screen.getByTestId('composer'), 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()

    rerender(pane(true))
    expect(container.querySelector(OVERLAY)).toBeNull()
    expect(container.querySelector('.pane')?.getAttribute('data-composer-scope-key')).toBe('pane:1')

    rerender(pane(false))
    expect(container.querySelector(OVERLAY)).toBeNull()
    fireDrag(screen.getByTestId('composer'), 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()
  })

  it('keeps the overlay up while the cursor crosses children, and drops it on exit', () => {
    const { transcript, container } = renderPane(<ClaimingComposer />)
    fireDrag(transcript, 'dragover', workspaceDrag())

    fireDrag(transcript, 'dragleave', workspaceDrag(), screen.getByTestId('composer'))
    expect(container.querySelector(OVERLAY)).not.toBeNull()

    fireDrag(transcript, 'dragleave', workspaceDrag(), screen.getByTestId('terminal-behind'))
    expect(container.querySelector(OVERLAY)).toBeNull()
  })

  it('clears an OS drag overlay from the document drop the preload route consumes', () => {
    const { transcript, container } = renderPane(<ClaimingComposer />)
    fireDrag(transcript, 'dragover', osDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()

    // The preload listener stops this event at `document`, so the surface never
    // sees it as a React drop.
    act(() => {
      document.dispatchEvent(new Event('drop', { bubbles: false }))
    })
    expect(container.querySelector(OVERLAY)).toBeNull()
  })

  it('observes a native drop that ends before the hover render commits', () => {
    const consumeDrop = (event: Event): void => event.stopPropagation()
    document.addEventListener('drop', consumeDrop, true)

    try {
      const { transcript, container } = renderPane(<ClaimingComposer />)
      act(() => {
        fireDrag(transcript, 'dragover', osDrag())
        fireDrag(transcript, 'drop', osDrag())
      })
      expect(container.querySelector(OVERLAY)).toBeNull()
    } finally {
      document.removeEventListener('drop', consumeDrop, true)
    }
  })

  it('keeps end listeners stable across drags and removes them with the composer', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    try {
      const { transcript, unmount } = renderPane(<ClaimingComposer />)

      const ends = (): number =>
        add.mock.calls.filter(([type]) => type === 'drop' || type === 'dragend').length

      expect(ends()).toBe(2)
      fireDrag(transcript, 'dragover', osDrag())
      fireDrag(transcript, 'drop', osDrag())
      fireDrag(transcript, 'dragover', osDrag())
      expect(ends()).toBe(2)
      unmount()

      const removedEnds = remove.mock.calls.filter(
        ([type]) => type === 'drop' || type === 'dragend'
      )

      expect(removedEnds).toHaveLength(2)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatQueuedMessageEditor } from './NativeChatQueuedMessageEditor'
import type * as NativeChatAttachmentUpload from './native-chat-attachment-upload'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import {
  nativeChatPaneDragKind,
  registerNestedWorkspaceDropSink
} from './native-chat-pane-file-drop'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./native-chat-attachment-upload', async (original) => ({
  ...(await original<typeof NativeChatAttachmentUpload>()),
  resolveNativeChatAttachmentOwnerForWorktree: () => ({ kind: 'local' })
}))

const OVERLAY = '[data-native-chat-drop-overlay="true"]'
const IGNORE_DRAG = (): void => {}

function EditingCard({ disabled = false }: { disabled?: boolean }) {
  return (
    <TooltipProvider>
      <NativeChatQueuedMessageEditor
        editor={{
          messageId: 'card',
          text: 'edit',
          acquiring: false,
          saving: disabled,
          canSave: true,
          change: IGNORE_DRAG,
          save: IGNORE_DRAG,
          cancel: IGNORE_DRAG,
          images: {
            chips: [],
            empty: false,
            intake: {
              begin: () => null,
              resolve: () => false,
              reveal: IGNORE_DRAG,
              drop: () => false,
              append: () => [],
              remove: IGNORE_DRAG
            }
          }
        }}
        attachTo={{
          terminalTabId: 'tab',
          transport: {
            sessionId: 's',
            worktreeId: 'wt',
            runtimeEnvironmentId: null,
            acceptsImages: true
          }
        }}
      />
    </TooltipProvider>
  )
}

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
    destinationKey: 'pane:1',
    captureExternalDrop: () => async () => {},
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
  it('scopes OS and in-app hover to the editing card, clears on exit/end and respects disabled intake', () => {
    const { container, rerender } = renderPane(
      <>
        <ClaimingComposer />
        <EditingCard />
      </>
    )
    const edit = screen.getByRole('textbox').closest('[data-queued-message-editor]')
    if (!(edit instanceof HTMLElement)) {
      throw new Error('Expected editing card')
    }
    for (const drag of [osDrag(), workspaceDrag()]) {
      fireDrag(screen.getByTestId('transcript'), 'dragover', drag)
      fireDrag(screen.getByRole('textbox'), 'dragover', drag)
      expect(container.querySelectorAll(OVERLAY)).toHaveLength(1)
      expect(edit.querySelector(OVERLAY)?.textContent).toContain('Drop to attach to this message')
      fireDrag(
        screen.getByRole('textbox'),
        'dragleave',
        drag,
        screen.getByRole('button', { name: 'Attach file' })
      )
      expect(edit.querySelector(OVERLAY)).not.toBeNull()
      fireDrag(
        screen.getByRole('button', { name: 'Attach file' }),
        'dragleave',
        drag,
        screen.getByTestId('transcript')
      )
      expect(edit.querySelector(OVERLAY)).toBeNull()
      fireDrag(screen.getByRole('textbox'), 'dragover', drag)
      act(() => document.dispatchEvent(new Event('dragend', { bubbles: true })))
      expect(edit.querySelector(OVERLAY)).toBeNull()
      fireDrag(screen.getByRole('textbox'), 'dragover', drag)
      fireDrag(screen.getByRole('textbox'), 'drop', drag)
      expect(container.querySelector(OVERLAY)).toBeNull()
    }
    rerender(
      <NativeChatPaneFileDropSurface className="pane">
        <ClaimingComposer />
        <EditingCard disabled />
      </NativeChatPaneFileDropSurface>
    )
    fireDrag(screen.getByRole('textbox'), 'dragover', osDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
  })

  it('routes a drop on the transcript to the composer that claimed the pane', () => {
    const onDropCapture = vi.fn()
    const { transcript, container } = renderPane(<ClaimingComposer onDropCapture={onDropCapture} />)

    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()

    fireDrag(transcript, 'drop', workspaceDrag())
    expect(onDropCapture).toHaveBeenCalledTimes(1)
    expect(container.querySelector(OVERLAY)).toBeNull()
  })

  it('hands an in-app drop on an editing queued card to that card, through the claim', () => {
    const composerDrop = vi.fn()
    const sink = vi.fn()
    const { container } = renderPane(
      <>
        <ClaimingComposer onDropCapture={composerDrop} />
        <div data-os-file-drop-owner="" data-testid="owner">
          <span data-testid="card">card</span>
        </div>
      </>
    )
    const unregister = registerNestedWorkspaceDropSink(screen.getByTestId('owner'), sink)
    const card = screen.getByTestId('card')
    fireDrag(card, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
    fireDrag(card, 'drop', workspaceDrag())
    expect(composerDrop).toHaveBeenCalledWith(expect.anything(), sink)
    unregister()
  })

  it('owns OS drops without publishing a scope marker', () => {
    const { container } = renderPane(<ClaimingComposer />)
    const surface = container.querySelector('.pane')
    expect(surface?.hasAttribute('data-os-file-drop-owner')).toBe(true)
    expect(surface?.hasAttribute('data-composer-scope-key')).toBe(false)
  })

  it('keeps an OS owner even while no composer is mounted', () => {
    const { transcript, container } = renderPane(null)
    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
    expect(container.querySelector('.pane')?.hasAttribute('data-os-file-drop-owner')).toBe(true)
  })

  it('does not invite a drop the guarded composer will refuse', () => {
    const onDragOverCapture = vi.fn()
    const { transcript, container } = renderPane(
      <ClaimingComposer disabled onDragOverCapture={onDragOverCapture} />
    )
    fireDrag(transcript, 'dragover', workspaceDrag())
    expect(container.querySelector(OVERLAY)).toBeNull()
    // Refused composer drags must not fall through to the terminal.
    expect(onDragOverCapture).toHaveBeenCalledTimes(1)
  })

  it('shows the overlay for OS drags while keeping workspace handlers separate', () => {
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
    expect(container.querySelector('.pane')?.hasAttribute('data-os-file-drop-owner')).toBe(true)

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

  it('clears an OS drag overlay when a drop ends outside the pane', () => {
    const { transcript, container } = renderPane(<ClaimingComposer />)
    fireDrag(transcript, 'dragover', osDrag())
    expect(container.querySelector(OVERLAY)).not.toBeNull()

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

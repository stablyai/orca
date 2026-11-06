// @vitest-environment happy-dom

import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as NativeChatAttachmentUpload from './native-chat-attachment-upload'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./native-chat-attachment-upload', async (original) => ({
  ...(await original<typeof NativeChatAttachmentUpload>()),
  resolveNativeChatAttachmentOwnerForWorktree: () => ({ kind: 'local' })
}))

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

describe('NativeChatPaneFileDropSurface', () => {
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
})

it('direct drops override last focus; background keeps stable focus through disable and remount, with questions independent', () => {
  function Composer({ scope, disabled = false }: { scope: string; disabled?: boolean }) {
    const [value, setValue] = useState('')
    useNativeChatPaneFileDropClaim({
      destinationKey: scope,
      focusScopeKey: scope,
      disabled,
      captureExternalDrop: () => async () => {},
      onDragOverCapture: (event) => {
        if (!disabled) {
          event.preventDefault()
        }
      },
      onDropCapture: (event) => {
        if (!disabled) {
          setValue((previous) => previous + event.dataTransfer.getData(WORKSPACE_FILE_PATH_MIME))
        }
      }
    })
    return (
      <div data-native-chat-composer-scope={scope}>
        <textarea aria-label={scope} value={value} readOnly disabled={disabled} />
      </div>
    )
  }
  function Pane({ disabled = false, revision = 0 }: { disabled?: boolean; revision?: number }) {
    return (
      <NativeChatPaneFileDropSurface className="pane">
        <span>background</span>
        <input aria-label="question" />
        <Composer scope="bottom" />
        <Composer key={revision} scope="queued-edit:row" disabled={disabled} />
      </NativeChatPaneFileDropSurface>
    )
  }
  const view = render(<Pane />)
  const input = (label: string): HTMLTextAreaElement => {
    const element = view.getByLabelText(label)
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error('expected composer textarea')
    }
    return element
  }
  const bottom = () => input('bottom')
  const edit = () => input('queued-edit:row')
  fireEvent.focus(edit())
  fireDrag(bottom(), 'drop', workspaceDrag())
  expect(bottom().value).toBe('/repo/a.ts')
  expect(edit().value).toBe('')
  fireDrag(view.getByText('background'), 'drop', workspaceDrag())
  expect(edit().value).toBe('/repo/a.ts')
  fireEvent.focus(view.getByLabelText('question'))
  fireDrag(view.getByText('background'), 'drop', workspaceDrag())
  expect(edit().value).toBe('/repo/a.ts/repo/a.ts')
  view.rerender(<Pane disabled />)
  fireDrag(edit(), 'drop', workspaceDrag())
  expect(bottom().value).toBe('/repo/a.ts')
  view.rerender(<Pane />)
  fireDrag(view.getByText('background'), 'drop', workspaceDrag())
  expect(edit().value).toBe('/repo/a.ts/repo/a.ts/repo/a.ts')
  view.rerender(<Pane revision={1} />)
  fireDrag(view.getByText('background'), 'drop', workspaceDrag())
  expect(edit().value).toBe('/repo/a.ts')
})

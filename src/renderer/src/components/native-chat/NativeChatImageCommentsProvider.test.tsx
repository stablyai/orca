// @vitest-environment happy-dom
import { useContext, useState, type RefObject } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativeChatImageCommentsContext,
  NativeChatImageCommentsProvider
} from './NativeChatImageCommentsProvider'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./NativeChatImageCommentsDialog', () => ({
  NativeChatImageCommentsDialog: ({
    onDone
  }: {
    onDone: (png: string, text: string) => Promise<void>
  }) => {
    const [failed, setFailed] = useState(false)
    return (
      <div role="dialog">
        <button onClick={() => void onDone('png', 'Comments').catch(() => setFailed(true))}>
          Save comments
        </button>
        {failed ? <p role="alert">Retry available</p> : null}
      </div>
    )
  }
}))

function destination(draftKey: string): NativeChatComposerHandle {
  return {
    draftKey,
    attachCommentedImage: vi.fn(async () => true),
    insertAgentReferences: () => true,
    focus: () => true,
    insertTypedText: () => true,
    acceptsText: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: () => false
  }
}
function Open() {
  const open = useContext(NativeChatImageCommentsContext)
  return (
    <button onClick={() => open?.(async () => new Blob(['image']), 'Image')}>Open comments</button>
  )
}
afterEach(cleanup)

it.each([true, false])(
  'retries only in the original draft after a composer remount (same=%s)',
  async (same) => {
    const first = destination('draft-a')
    const ref: RefObject<NativeChatComposerHandle | null> = { current: first }
    const view = render(
      <NativeChatImageCommentsProvider composerRef={ref}>
        <Open />
      </NativeChatImageCommentsProvider>
    )
    fireEvent.click(view.getByRole('button', { name: 'Open comments' }))
    ref.current = null
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save comments' }))
    })
    expect(view.getByRole('alert')).toBeTruthy()
    const next = destination(same ? 'draft-a' : 'draft-b')
    ref.current = next
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save comments' }))
    })
    if (same) {
      await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
      expect(next.attachCommentedImage).toHaveBeenCalledWith('png', 'Comments')
    } else {
      expect(view.getByRole('dialog')).toBeTruthy()
      expect(next.attachCommentedImage).not.toHaveBeenCalled()
    }
    expect(first.attachCommentedImage).not.toHaveBeenCalled()
  }
)

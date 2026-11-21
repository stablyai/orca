// @vitest-environment happy-dom
// A page admitted while the chat is hidden restores against what the reader last saw.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativeChatPrependSnapshot,
  type NativeChatPrependAnchor
} from './NativeChatPrependSnapshot'
import type { NativeChatContentSnapshot } from './use-native-chat-content-anchor'
import type { NativeChatTranscriptWindow } from './use-native-chat-transcript-window'

afterEach(cleanup)

const LAST_SEEN: NativeChatContentSnapshot = {
  anchors: [{ key: 'message:a', row: 'a', inset: 12 }]
}

function boundary() {
  const snapshotContent = vi.fn(() => LAST_SEEN)
  const preserveContent = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the boundary calls only these two window methods.
  const window = { snapshotContent, preserveContent } as unknown as NativeChatTranscriptWindow
  const view = (anchor: NativeChatPrependAnchor) => (
    <NativeChatPrependSnapshot anchor={anchor} window={window}>
      <div />
    </NativeChatPrependSnapshot>
  )
  return { view, snapshotContent, preserveContent }
}

it('restores the content the reader last saw when a page landed while the chat was hidden', () => {
  const { view, preserveContent } = boundary()
  const { rerender } = render(view({ sourceKey: 's', prependRevision: 0, isVisible: true }))

  rerender(view({ sourceKey: 's', prependRevision: 0, isVisible: false }))
  rerender(view({ sourceKey: 's', prependRevision: 1, isVisible: false }))
  expect(preserveContent).not.toHaveBeenCalled()

  rerender(view({ sourceKey: 's', prependRevision: 1, isVisible: true }))
  expect(preserveContent).toHaveBeenCalledExactlyOnceWith(LAST_SEEN)
})

it('restores nothing on reveal when no page landed while hidden', () => {
  const { view, preserveContent } = boundary()
  const { rerender } = render(view({ sourceKey: 's', prependRevision: 0, isVisible: true }))
  rerender(view({ sourceKey: 's', prependRevision: 0, isVisible: false }))
  rerender(view({ sourceKey: 's', prependRevision: 0, isVisible: true }))

  expect(preserveContent).not.toHaveBeenCalled()
})

it('drops what the reader saw when the source changes while hidden', () => {
  const { view, preserveContent } = boundary()
  const { rerender } = render(view({ sourceKey: 's', prependRevision: 0, isVisible: true }))
  rerender(view({ sourceKey: 's', prependRevision: 0, isVisible: false }))
  rerender(view({ sourceKey: 'other', prependRevision: 1, isVisible: false }))
  rerender(view({ sourceKey: 'other', prependRevision: 2, isVisible: true }))

  expect(preserveContent).not.toHaveBeenCalled()
})

it('snapshots before a visible page lands and hands the snapshot over after it', () => {
  const { view, snapshotContent, preserveContent } = boundary()
  const { rerender } = render(view({ sourceKey: 's', prependRevision: 0, isVisible: true }))
  rerender(view({ sourceKey: 's', prependRevision: 1, isVisible: true }))

  expect(snapshotContent).toHaveBeenCalledOnce()
  expect(preserveContent).toHaveBeenCalledExactlyOnceWith(LAST_SEEN)
})

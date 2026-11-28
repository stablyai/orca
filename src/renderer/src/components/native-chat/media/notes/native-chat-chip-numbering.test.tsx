// @vitest-environment happy-dom
// Annotating a chip in the message box numbers its notes on after the notes already in the message,
// as annotating an image of a sent message does.
import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'

const opened = vi.hoisted(() => {
  const offsets: (number | undefined)[] = []
  return { offsets }
})
vi.mock('./NativeChatMediaViewer', () => ({
  NativeChatMediaViewer: (props: { open: boolean; offset?: number }) => {
    if (props.open) {
      opened.offsets.push(props.offset)
    }
    return null
  }
}))
vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: () => undefined,
  loadLocalImageSrc: vi.fn()
}))

const SCOPE = 'agent-session:numbering'

beforeEach(async () => {
  opened.offsets.length = 0
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})

it('a chip opened from a message that already carries notes numbers on after them', () => {
  updateNativeChatComposerDraft(
    SCOPE,
    {
      text: 'look\n\nNotes on a.png (numbered marks in the attached image):\n1. this\n2. that'
    },
    'immediate'
  )
  render(
    createElement(NativeChatImageAttachmentPreview, {
      attachment: { id: 'chip-1', path: '/tmp/a-notes.png', previewUrl: 'data:image/png;base64,' },
      notesScopeKey: SCOPE,
      onRemove: vi.fn()
    })
  )
  fireEvent.click(screen.getByTitle('a-notes.png'))
  expect(opened.offsets.at(-1)).toBe(2)
})

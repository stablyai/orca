import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { imageReferenceToken } from '../../../../../../shared/native-chat/native-chat-image-reference'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from '../../paste/native-chat-pasted-text-reference'
import { settleNativeChatPastedText } from '../../paste/native-chat-composer-pasted-text-references'
import { promptSkillRefs } from '../../composer/editor/native-chat-prompt-document'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachment
} from '../../attachments/chips/native-chat-pending-attachment-cache'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'

const skill = { name: 'review', path: '/remote/skills/review/SKILL.md' }
const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'text', text: '$review [Image #1]' },
    { type: 'image-ref', url: 'https://host/original.png', alt: 'original' }
  ],
  skills: [skill]
}
let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
beforeEach(async () => {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  nativeChatPastedTextOperations.clear()
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
})

describe('queued edit draft ownership', () => {
  it('returns a full draft after existing content, keeps skill/paste identity, and redirects late uploads', () => {
    updateNativeChatComposerDraft(
      'bottom',
      { text: 'already here', images: [{ id: 'bottom-image', path: '/bottom.png' }] },
      'immediate'
    )
    const edit = createNativeChatQueuedEditDraft(body, 'bottom')
    const paste = 'd851d135-98ac-44d1-b122-caf190002345'
    const pendingPaste = 'd851d135-98ac-44d1-b122-caf190002346'
    const text = `$review changed ${nativeChatPastedTextToken(paste)} ${nativeChatPastedTextToken(pendingPaste)} ${imageReferenceToken('late-image')}`
    const seeded = readNativeChatComposerDraft(edit.scopeKey).document
    updateNativeChatComposerDraft(
      edit.scopeKey,
      {
        text,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                seeded!.content![0]!.content![0]!,
                ...(promptTextContent(text.slice('$review'.length)).content![0]!.content ?? [])
              ]
            }
          ]
        },
        pastedTextFiles: { [paste]: '/remote/paste.txt' },
        images: [...edit.initial.images, { id: 'added', path: '/remote/added.png' }]
      },
      'immediate'
    )
    addNativeChatPendingAttachment(edit.scopeKey, { id: 'late-image', path: '', pending: true })
    nativeChatPastedTextOperations.set(pendingPaste, {
      scopeKey: edit.scopeKey,
      text: 'large paste'
    })
    expect(handBackNativeChatQueuedEdit(edit)).toBe(true)
    discardNativeChatQueuedEdit(edit)
    expect(settleNativeChatPendingAttachment(edit.scopeKey, 'late-image', '/remote/late.png')).toBe(
      true
    )
    expect(settleNativeChatPastedText(pendingPaste, '/remote/late.txt')).toBe(true)
    const returned = readNativeChatComposerDraft('bottom')
    expect(returned.text).toBe(`already here\n\n${text}`)
    expect(promptSkillRefs(returned.document)).toEqual([skill])
    expect(returned.pastedTextFiles).toEqual({
      [paste]: '/remote/paste.txt',
      [pendingPaste]: '/remote/late.txt'
    })
    expect(returned.images.map(({ id }) => id)).toEqual(['bottom-image', 'added', 'late-image'])
    expect(returned.text).not.toContain(imageReferenceToken(edit.kept[0]!.id))
    expect(readNativeChatComposerDraft(edit.scopeKey).text).toBe('')
  })
})

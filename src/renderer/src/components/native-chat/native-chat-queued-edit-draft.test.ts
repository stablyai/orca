import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { queuedMessageWithEdit } from '../../../../shared/queued-message-edit'
import { promptTextContent } from './native-chat-prompt-document-text'
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { imageReferenceToken } from '../../../../shared/native-chat/native-chat-image-reference'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import { settleNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { promptSkillRefs } from './native-chat-prompt-document'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit,
  nativeChatQueuedEditInput,
  nativeChatQueuedEditDirty
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
  it('seeds skill identity without a catalog, preserves original image blocks and omits unsupported fields', async () => {
    const edit = createNativeChatQueuedEditDraft(body, 'bottom')
    expect(nativeChatQueuedEditInput(edit, true, true)).toEqual({
      text: '$review [Image #1]',
      images: [body.blocks[1]],
      skills: [skill]
    })
    expect(nativeChatQueuedEditInput(edit, false, false)).toEqual({ text: '$review [Image #1]' })
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.has(edit.scopeKey)).toBe(false)
    discardNativeChatQueuedEdit(edit)
  })

  it('retains distinct selected paths for repeated same-name skill tokens', () => {
    const skills = [skill, { ...skill, path: '/other/SKILL.md' }]
    const edit = createNativeChatQueuedEditDraft(
      {
        ...body,
        blocks: [{ type: 'text', text: '$review $review' }],
        skills
      },
      'bottom'
    )
    expect(nativeChatQueuedEditInput(edit, true, true).skills).toEqual(skills)
    expect(nativeChatQueuedEditDirty(edit)).toBe(false)
    discardNativeChatQueuedEdit(edit)
  })

  it.each(['review.v2', '検証.v2'])(
    'retains picker-valid %s identities without a catalog',
    (name) => {
      const skills = [
        { name, path: '/remote/first/SKILL.md' },
        { name, path: '/remote/second/SKILL.md' }
      ]
      const edit = createNativeChatQueuedEditDraft(
        { ...body, blocks: [{ type: 'text', text: `$${name} $${name}` }], skills },
        'bottom'
      )
      expect(nativeChatQueuedEditDirty(edit)).toBe(false)
      expect(nativeChatQueuedEditInput(edit, true, true).skills).toEqual(skills)
      discardNativeChatQueuedEdit(edit)
    }
  )

  it('normalizes repeated skill refs when deciding whether to hand a draft back', () => {
    const repeated = { ...body, skills: [skill, skill] }
    const edit = createNativeChatQueuedEditDraft(repeated, 'bottom')
    expect(nativeChatQueuedEditDirty(edit)).toBe(false)
    expect(handBackNativeChatQueuedEdit(edit)).toBe(false)
    discardNativeChatQueuedEdit(edit)
  })

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

  it('Cancel prevents late operations from reviving a closed edit', () => {
    const edit = createNativeChatQueuedEditDraft(body, 'bottom')
    addNativeChatPendingAttachment(edit.scopeKey, { id: 'cancelled', path: '', pending: true })
    discardNativeChatQueuedEdit(edit)
    expect(settleNativeChatPendingAttachment(edit.scopeKey, 'cancelled', '/late.png')).toBe(false)
    updateNativeChatComposerDraft(edit.scopeKey, { text: 'late text' }, 'immediate')
    expect(readNativeChatComposerDraft(edit.scopeKey).text).toBe('')
    expect(readNativeChatComposerDraft('bottom').text).toBe('')
  })
})

it.each(['/', '$'] as const)(
  'reopens supplied %s identities through rich nodes, serializer and the next host body',
  (sigil) => {
    const skills = [
      { name: 'model', path: '/A/SKILL.md' },
      { name: 'model', path: '/B/SKILL.md' },
      { name: 'skill:review.v2', path: '/pi/SKILL.md' },
      { name: '审查', path: '/unicode/SKILL.md' }
    ]
    const text = `${sigil}model ${sigil}model\n${sigil}skill:review.v2 ${sigil}审查`
    const queued: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }],
      skills
    }
    const edit = createNativeChatQueuedEditDraft(queued, 'bottom')
    expect(promptSkillRefs(readNativeChatComposerDraft(edit.scopeKey).document)).toEqual(skills)
    const fields = nativeChatQueuedEditInput(edit, true, true)
    expect(fields.skills).toEqual(skills)
    expect(structuredAgentSessionSendBody(text, [], skills).skills).toEqual(
      sigil === '$' ? skills : undefined
    )
    const result = queuedMessageWithEdit(queued, fields)
    expect(result).toEqual({ ok: true, body: queued })
    discardNativeChatQueuedEdit(edit)
  }
)

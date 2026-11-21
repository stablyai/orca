// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit,
  nativeChatQueuedEditDirty,
  nativeChatQueuedEditInput
} from './native-chat-queued-edit-draft'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import {
  cancelNativeChatReplyTarget,
  nativeChatReplyCustody,
  readNativeChatReplyTarget,
  resetNativeChatReplyTargetsForTests,
  setNativeChatReplyTarget
} from '../../composer/reply/native-chat-reply-target'
import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import {
  NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS,
  rememberNativeChatReplySource,
  resetNativeChatReplySourcesForTests
} from '../../composer/reply/native-chat-reply-sources'
import { returnMessageToComposer } from '../../session/structured/delivery/structured-agent-session-message-hand-back'

const SENT = withNativeChatReplyContext(
  'Why blue?',
  { author: 'agent', excerpt: 'Updated the cards.' },
  'Claude'
)
const queued = () => ({
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: SENT }]
})

beforeEach(() => {
  localStorage.clear()
  resetNativeChatReplyTargetsForTests()
  resetNativeChatReplySourcesForTests()
  clearNativeChatComposerDraftsForTests()
})

it('edits a queued reply as words plus a strip and saves it unchanged as the same text', () => {
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:main')
  expect(readNativeChatComposerDraft(edit.scopeKey).text).toBe('Why blue?')
  expect(readNativeChatReplyTarget(edit.scopeKey)?.excerpt).toBe('Updated the cards.')
  expect(nativeChatQueuedEditDirty(edit)).toBe(false)
  expect(nativeChatQueuedEditInput(edit, true, false).text).toBe(SENT)
})

it('cancelling the strip counts as an edit and saves the words without the quote', () => {
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:main')
  cancelNativeChatReplyTarget(edit.scopeKey)
  expect(nativeChatQueuedEditDirty(edit)).toBe(true)
  expect(nativeChatQueuedEditInput(edit, true, false).text).toBe('Why blue?')
})

it('an edit handed back to the message box keeps answering the same message', () => {
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:main')
  updateNativeChatComposerDraft(edit.scopeKey, { text: 'Why blue, really?' }, 'immediate')
  handBackNativeChatQueuedEdit(edit)
  expect(readNativeChatComposerDraft('agent-session:main').text).toBe('Why blue, really?')
  expect(readNativeChatReplyTarget('agent-session:main')?.excerpt).toBe('Updated the cards.')
  expect(readNativeChatReplyTarget(edit.scopeKey)).toBeNull()
})

it('an edit handed back to a box already answering another message keeps its quote in what the editor shows', () => {
  setNativeChatReplyTarget('agent-session:busy', {
    id: 'b',
    messageId: 'm-b',
    author: 'agent',
    excerpt: 'Another answer.'
  })
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:busy')
  const edited = 'Why blue, really?'
  updateNativeChatComposerDraft(
    edit.scopeKey,
    { text: edited, document: promptTextContent(edited) },
    'immediate'
  )
  handBackNativeChatQueuedEdit(edit)
  const returned = readNativeChatComposerDraft('agent-session:busy')
  const quoted = SENT.replace('Why blue?', edited)
  expect(returned.text).toBe(quoted)
  // The editor rebuilds its text from the document, so typing there must not drop the quote.
  const lines = (returned.document?.content ?? []).map((paragraph) =>
    (paragraph.content ?? []).map((node) => node.text ?? '').join('')
  )
  expect(lines.join('\n')).toBe(quoted)
  expect(readNativeChatReplyTarget('agent-session:busy')?.id).toBe('b')
})

it('a queued edit’s reply is never saved and leaves nothing behind once the edit closes', () => {
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:main')
  expect(nativeChatReplyCustody(edit.scopeKey)).toBeGreaterThan(0)
  expect(localStorage.getItem('orca.nativeChat.replyTargets.v1') ?? '').not.toContain(edit.scopeKey)
  discardNativeChatQueuedEdit(edit)
  expect(readNativeChatReplyTarget(edit.scopeKey)).toBeNull()
  expect(nativeChatReplyCustody(edit.scopeKey)).toBe(0)
})

it('an edit answering A handed back to a box answering B with the same words keeps A, and B stays', () => {
  // Two answers with identical words: only their ids tell them apart.
  setNativeChatReplyTarget('agent-session:same', {
    id: 'b',
    messageId: 'm-b',
    author: 'agent',
    excerpt: 'Updated the cards.',
    agentLabel: 'Claude'
  })
  rememberNativeChatReplySource('agent-session:same', SENT, 'm-a')
  const edit = createNativeChatQueuedEditDraft(queued(), 'agent-session:same')
  expect(readNativeChatReplyTarget(edit.scopeKey)?.messageId).toBe('m-a')
  const edited = 'Why blue, really?'
  updateNativeChatComposerDraft(
    edit.scopeKey,
    { text: edited, document: promptTextContent(edited) },
    'immediate'
  )
  handBackNativeChatQueuedEdit(edit)
  // A is not B: its quote stays in the words, and the strip keeps answering B.
  expect(readNativeChatComposerDraft('agent-session:same').text).toBe(
    SENT.replace('Why blue?', edited)
  )
  expect(readNativeChatReplyTarget('agent-session:same')?.messageId).toBe('m-b')
})

it('a rewound reply to A into a box answering B with the same words keeps A, and B stays', () => {
  setNativeChatReplyTarget('agent-session:rewind', {
    id: 'b',
    messageId: 'm-b',
    author: 'agent',
    excerpt: 'Updated the cards.',
    agentLabel: 'Claude'
  })
  rememberNativeChatReplySource('agent-session:rewind', SENT, 'm-a')
  returnMessageToComposer('agent-session:rewind', 'rewound', [{ type: 'text', text: SENT }])
  expect(readNativeChatComposerDraft('agent-session:rewind').text).toBe(SENT)
  expect(readNativeChatReplyTarget('agent-session:rewind')?.messageId).toBe('m-b')
  // Its own reply handed back again (same original) is found already there.
  setNativeChatReplyTarget('agent-session:again', {
    id: 'a',
    messageId: 'm-a',
    author: 'agent',
    excerpt: 'Updated the cards.',
    agentLabel: 'Claude'
  })
  rememberNativeChatReplySource('agent-session:again', SENT, 'm-a')
  returnMessageToComposer('agent-session:again', 'rewound', [{ type: 'text', text: SENT }])
  expect(readNativeChatComposerDraft('agent-session:again').text).toBe('Why blue?')
})

it('a hand-back whose original is unknown or ambiguous counts as the reply already in the box', () => {
  for (const [scope, known] of [
    ['agent-session:unknown', ''],
    ['agent-session:ambiguous', NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS]
  ] as const) {
    setNativeChatReplyTarget(scope, {
      id: 'b',
      messageId: 'm-b',
      author: 'agent',
      excerpt: 'Updated the cards.',
      agentLabel: 'Claude'
    })
    if (known) {
      rememberNativeChatReplySource(scope, SENT, 'm-x')
      rememberNativeChatReplySource(scope, SENT, 'm-y')
    }
    // Queued Edit: the same words with no exact original are taken as that reply.
    const edit = createNativeChatQueuedEditDraft(queued(), scope)
    expect(readNativeChatReplyTarget(edit.scopeKey)?.messageId).toBe(known)
    updateNativeChatComposerDraft(
      edit.scopeKey,
      { text: 'Why blue, really?', document: promptTextContent('Why blue, really?') },
      'immediate'
    )
    handBackNativeChatQueuedEdit(edit)
    expect(readNativeChatComposerDraft(scope).text).toBe('Why blue, really?')
    expect(readNativeChatReplyTarget(scope)?.messageId).toBe('m-b')
    // Rewind: the same.
    returnMessageToComposer(scope, `rewound-${known}`, [{ type: 'text', text: SENT }])
    expect(readNativeChatReplyTarget(scope)?.messageId).toBe('m-b')
  }
})

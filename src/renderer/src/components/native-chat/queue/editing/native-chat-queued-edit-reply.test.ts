// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  nativeChatQueuedEditDirty,
  nativeChatQueuedEditInput
} from './native-chat-queued-edit-draft'
import { withNativeChatReplyContext } from '../../composer/reply/native-chat-reply-quote'
import {
  cancelNativeChatReplyTarget,
  readNativeChatReplyTarget,
  resetNativeChatReplyTargetsForTests
} from '../../composer/reply/native-chat-reply-target'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'

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

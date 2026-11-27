// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

// Nothing is stood in: the queued-edit draft, the draft store and the outbound policy run for real.
// Save writes exactly what this admission returns, and nothing when it refuses.
const { createNativeChatQueuedEditDraft, nativeChatQueuedEditAdmission } =
  await import('./native-chat-queued-edit-draft')
const { readNativeChatComposerDraft, updateNativeChatComposerDraft } =
  await import('../../drafts/native-chat-composer-draft-store')
const { formatNativeChatFileReference } =
  await import('../../../../../../shared/native-chat/input/composer/agent-image-paste')
const { nativeChatBrowserFileRefusalParts } =
  await import('../../attachments/native-chat-browser-file-references')
const { agentSessionWriteNoticeText } =
  await import('../../messages/notices/agent-session-write-notice-text')

beforeEach(() => {
  localStorage.clear()
})

const card = (): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'original card' }]
})

// D11-01 / C15-04. A copied returned reference pasted into an editable card: Save is refused before
// any write, the hosted card body is unchanged, and the edit keeps the person's text.
it('refuses a queued-card update naming a browser file, keeping the card and the edit', () => {
  const body = card()
  const edit = createNativeChatQueuedEditDraft(body, 'agent-session:queued-refused')
  const stale = 'orca-browser-file:queued/old.png'
  const text = `original card ${formatNativeChatFileReference(stale)}`
  updateNativeChatComposerDraft(edit.scopeKey, { text }, 'immediate')

  expect(nativeChatQueuedEditAdmission(edit, true, false, 'queued-refused')).toEqual({
    refused: agentSessionWriteNoticeText(
      nativeChatBrowserFileRefusalParts([stale], 'notDoneQueuedEdit')
    )
  })
  // Save words its own refusal: the edit wasn't saved, never that a message wasn't sent.
  expect(nativeChatQueuedEditAdmission(edit, true, false, 'queued-refused')).not.toMatchObject({
    refused: expect.stringMatching(/not sent/i)
  })
  expect(edit.body).toBe(body)
  expect(body).toEqual(card())
  expect(readNativeChatComposerDraft(edit.scopeKey).text).toBe(text)
})

// The paired control: a valid replacement is admitted with exactly the edited text, as the one write.
it('admits a valid queued-card update with its exact text', () => {
  const edit = createNativeChatQueuedEditDraft(card(), 'agent-session:queued-valid')
  const text = `original card ${formatNativeChatFileReference('/host/agent-session-attachments/u/a.png')}`
  updateNativeChatComposerDraft(edit.scopeKey, { text }, 'immediate')

  const admission = nativeChatQueuedEditAdmission(edit, true, false, 'queued-valid')

  expect(admission).toMatchObject({
    input: { text },
    edited: { ok: true, body: { blocks: [{ type: 'text', text }] } }
  })
})

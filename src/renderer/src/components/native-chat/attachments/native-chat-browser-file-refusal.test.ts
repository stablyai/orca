// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Nothing is stood in: staging, the held-elsewhere store and the wording run for real.
const { nativeChatBrowserFileRefusal } = await import('./native-chat-browser-file-refusal')
const { stageNativeChatDraftFile } = await import('../drafts/native-chat-draft-attachment-staging')
const { structuredAgentSessionDraftScopeKey } = await import('../drafts/native-chat-draft-scope')
const { readNativeChatHeldElsewhere, resetNativeChatHeldElsewhereForTests } =
  await import('../composer/controls/native-chat-held-elsewhere-notice')
const { nativeChatHeldElsewhereNow } = await import('./native-chat-browser-file-refusal')

// The live account: who holds the refused files now, read from the drafts (see D12-03).
const heldNow = (sessionId: string) => {
  const record = readNativeChatHeldElsewhere(sessionId)
  return record && nativeChatHeldElsewhereNow(record.references, sessionId).held
}
const { nativeChatHeldElsewhereNotice } =
  await import('../composer/controls/use-native-chat-held-elsewhere-notice')
const { agentSessionWriteNoticeText } =
  await import('../messages/notices/agent-session-write-notice-text')

beforeEach(() => {
  resetNativeChatHeldElsewhereForTests()
})

// A file no staging holds (bytes gone after a reload, say) is named as one this chat can't send, and
// is never called expired.
it('words an unheld file as not sendable here, not as expired', () => {
  const parts = nativeChatBrowserFileRefusal(['orca-browser-file:gone/old.png'], 'refusing-a')
  const text = agentSessionWriteNoticeText(parts!)

  expect(text).toBe(
    "Can't send old.png from this chat. Your message was not sent. Remove it and attach it again."
  )
  expect(text).not.toMatch(/expired/i)
  expect(heldNow('refusing-a')).toBeNull()
})

// A file intact in another chat's draft is said by that chat's persistent notice instead; the text
// words only what is left. A file this chat's own draft holds is not "elsewhere".
it('leaves a file held by another chat to the persistent notice', () => {
  const elsewhere = 'orca-browser-file:held/shot.png'
  const own = 'orca-browser-file:own/mine.png'
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-chat'), elsewhere)
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('refusing-b'), own)

  expect(nativeChatBrowserFileRefusal([elsewhere], 'refusing-b')).toBeNull()
  expect(heldNow('refusing-b')).toEqual({
    count: 1,
    ownerSessionId: 'owner-chat'
  })

  const parts = nativeChatBrowserFileRefusal([own], 'refusing-b')
  expect(agentSessionWriteNoticeText(parts!)).toContain("Can't send mine.png from this chat.")
  // A refusal with nothing held elsewhere replaces the last account.
  expect(heldNow('refusing-b')).toBeNull()
})

// The notice is one short line naming the count and the chat, with one action that opens it; without
// an open chat to name it names none and offers nothing.
it('says one line with the count and owning chat, and opens it', () => {
  let opened = 0
  const notice = nativeChatHeldElsewhereNotice(
    { count: 2, ownerSessionId: 'owner-chat' },
    { label: 'Fix login bug', open: () => (opened += 1) },
    () => {}
  )
  expect(notice.text).toBe('Not sent — 2 attachments in Fix login bug')
  expect(notice.text).not.toContain('\n')
  expect(notice.kind).toBe('error')
  expect(notice.stackActionWhenNarrow).toBe(true)
  expect(notice.action?.label).toBe('Open chat')
  notice.action?.onClick()
  expect(opened).toBe(1)

  const single = nativeChatHeldElsewhereNotice({ count: 1 }, null, () => {})
  expect(single.text).toBe('Not sent — 1 attachment in another chat')
  expect(single.action).toBeUndefined()
})

// The chat name is the person's own text: it sits in its own truncating span with its full name as
// the tooltip, and is never read as markup.
it('puts the chat name in its own truncating span', () => {
  const label = 'Fix <b>login</b> {{count}} bug'
  const notice = nativeChatHeldElsewhereNotice(
    { count: 1, ownerSessionId: 'owner-chat' },
    { label, open: () => {} },
    () => {}
  )
  expect(notice.text).toBe(`Not sent — 1 attachment in ${label}`)
  const html = renderToStaticMarkup(createElement(Fragment, null, notice.content))
  expect(html).toContain('Not sent — 1 attachment in <span')
  expect(html).toContain('class="inline-block max-w-[12ch] truncate')
  expect(html).toContain('title="Fix &lt;b&gt;login&lt;/b&gt; {{count}} bug"')
  expect(html).not.toContain('<b>')
})

// Files another chat holds are attributed to one chat only when that one chat's draft holds them all.
it('names no chat when the held files are in more than one chat', () => {
  const first = 'orca-browser-file:held/one.png'
  const second = 'orca-browser-file:held/two.png'
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-one'), first)
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-two'), second)

  expect(nativeChatBrowserFileRefusal([first, second], 'refusing-c')).toBeNull()
  const held = heldNow('refusing-c')
  expect(held).toEqual({ count: 2, severalChats: true })
  const notice = nativeChatHeldElsewhereNotice(held!, null, () => {})
  expect(notice.text).toBe('Not sent — attachments in other chats')
  expect(notice.action).toBeUndefined()

  // The control: both in one chat's draft name that chat.
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-one'), second)
  nativeChatBrowserFileRefusal([first, second], 'refusing-c')
  expect(heldNow('refusing-c')).toEqual({
    count: 2,
    ownerSessionId: 'owner-one'
  })
})

// A queued card's Save is not a send: it says the edit wasn't saved, in its own words, and leaves the
// composer's "Not sent" notice alone.
it('words a queued-card Save refusal for Save, not as a send', () => {
  const elsewhere = 'orca-browser-file:held/card.png'
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-card'), elsewhere)

  const parts = nativeChatBrowserFileRefusal([elsewhere], 'refusing-d', 'queued-edit')
  expect(agentSessionWriteNoticeText(parts!)).toBe(
    "1 attachment is in another chat's draft. Your edit wasn't saved."
  )
  expect(heldNow('refusing-d')).toBeNull()

  const mixed = nativeChatBrowserFileRefusal(
    [elsewhere, 'orca-browser-file:gone/old.png'],
    'refusing-d',
    'queued-edit'
  )
  expect(agentSessionWriteNoticeText(mixed!)).toBe(
    "1 attachment is in another chat's draft. Can't send old.png from this chat. Your edit wasn't saved. Remove it and attach it again."
  )
  expect(agentSessionWriteNoticeText(mixed!)).not.toMatch(/not sent/i)
  expect(heldNow('refusing-d')).toBeNull()
})

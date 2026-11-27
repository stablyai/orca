// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'

// Nothing is stood in: staging, the held-elsewhere store and the wording run for real.
const { nativeChatBrowserFileRefusal } = await import('./native-chat-browser-file-refusal')
const { stageNativeChatDraftFile } = await import('../drafts/native-chat-draft-attachment-staging')
const { structuredAgentSessionDraftScopeKey } = await import('../drafts/native-chat-draft-scope')
const { readNativeChatHeldElsewhere, resetNativeChatHeldElsewhereForTests } =
  await import('../composer/controls/native-chat-held-elsewhere-notice')
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
  expect(readNativeChatHeldElsewhere('refusing-a')).toBeNull()
})

// A file intact in another chat's draft is said by that chat's persistent notice instead; the text
// words only what is left. A file this chat's own draft holds is not "elsewhere".
it('leaves a file held by another chat to the persistent notice', () => {
  const elsewhere = 'orca-browser-file:held/shot.png'
  const own = 'orca-browser-file:own/mine.png'
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('owner-chat'), elsewhere)
  stageNativeChatDraftFile(structuredAgentSessionDraftScopeKey('refusing-b'), own)

  expect(nativeChatBrowserFileRefusal([elsewhere], 'refusing-b')).toBeNull()
  expect(readNativeChatHeldElsewhere('refusing-b')).toEqual({
    count: 1,
    ownerSessionId: 'owner-chat'
  })

  const parts = nativeChatBrowserFileRefusal([own], 'refusing-b')
  expect(agentSessionWriteNoticeText(parts!)).toContain("Can't send mine.png from this chat.")
  // A refusal with nothing held elsewhere replaces the last account.
  expect(readNativeChatHeldElsewhere('refusing-b')).toBeNull()
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
  expect(notice.text).toBe('Not sent — 2 attachments are still in your draft in Fix login bug')
  expect(notice.text).not.toContain('\n')
  expect(notice.action?.label).toBe('Open chat')
  notice.action?.onClick()
  expect(opened).toBe(1)

  const single = nativeChatHeldElsewhereNotice({ count: 1 }, null, () => {})
  expect(single.text).toBe("Not sent — 1 attachment is still in another chat's draft")
  expect(single.action).toBeUndefined()
})

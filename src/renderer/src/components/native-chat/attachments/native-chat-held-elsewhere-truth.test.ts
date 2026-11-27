// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

// The browser token store is the only stand-in: staging, draft custody, adoption, the held-elsewhere
// record, its live account and the chat-close teardown run for real.
vi.mock('@/lib/files/drop/browser-attachment-files', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserAttachmentFiles>()),
  releaseBrowserAttachmentFiles: () => {}
}))

const {
  adoptNativeChatStagedFile,
  reconcileNativeChatStagedDraft,
  stageNativeChatDraftFile,
  stagedNativeChatFiles
} = await import('../drafts/native-chat-draft-attachment-staging')
const { nativeChatStagedOwnershipVersion } = await import('../drafts/native-chat-staged-ownership')
const { captureNativeChatStagedInput } = await import('../drafts/native-chat-staged-input')
const { structuredAgentSessionDraftScopeKey: scopeOf } =
  await import('../drafts/native-chat-draft-scope')
const { nativeChatBrowserFileRefusal, nativeChatHeldElsewhereAt, nativeChatHeldElsewhereNow } =
  await import('./native-chat-browser-file-refusal')
const {
  nativeChatHeldElsewhereRecordCountForTests,
  readNativeChatHeldElsewhere,
  resetNativeChatHeldElsewhereForTests
} = await import('../composer/controls/native-chat-held-elsewhere-notice')
const { nativeChatHeldElsewhereOwnerTab } =
  await import('../composer/controls/use-native-chat-held-elsewhere-notice')
const { discardStructuredAgentSessionChatSends } =
  await import('@/lib/agent-session/launch/structured-agent-session-staged-prompt')

beforeEach(() => {
  resetNativeChatHeldElsewhereForTests()
})

const now = (sessionId: string) =>
  nativeChatHeldElsewhereNow(readNativeChatHeldElsewhere(sessionId)!.references, sessionId)

/** `path` staged in chat `sessionId`'s draft, which shows it as a chip. */
function inDraftOf(sessionId: string, path: string): void {
  stageNativeChatDraftFile(scopeOf(sessionId), path)
  reconcileNativeChatStagedDraft(scopeOf(sessionId), {
    text: '',
    images: [{ id: path, path }]
  })
}

// D12-03 / C16-01. A send's lease keeps an original readable but makes no chat its owner: only a
// draft that holds it is named, so the notice never sends anyone to a draft without the file.
it('names no chat whose only claim is a send lease', () => {
  const path = 'blob:truth-lease-only'
  stageNativeChatDraftFile(scopeOf('truth-leaser'), path)
  captureNativeChatStagedInput(scopeOf('truth-leaser'), { text: '', attachments: [{ path }] })
  reconcileNativeChatStagedDraft(scopeOf('truth-leaser'), { text: '', images: [] })
  expect(stagedNativeChatFiles(scopeOf('truth-leaser'))?.paths.has(path)).toBe(true)

  const parts = nativeChatBrowserFileRefusal([path], 'truth-refusing-a')

  expect(readNativeChatHeldElsewhere('truth-refusing-a')).toBeNull()
  expect(parts).not.toBeNull()
})

// The account follows custody as it moves: A holds it when refused, B adopts it, and the notice names
// B; once B's draft drops it, nobody holds it and the notice says to attach it again.
it('follows custody from A to B, then says the file is gone', () => {
  const path = 'blob:truth-moving'
  inDraftOf('truth-owner-a', path)
  nativeChatBrowserFileRefusal([path], 'truth-refusing-b')
  expect(now('truth-refusing-b')).toEqual({
    held: { count: 1, ownerSessionId: 'truth-owner-a' },
    gone: []
  })

  const before = nativeChatStagedOwnershipVersion()
  adoptNativeChatStagedFile(
    stagedNativeChatFiles(scopeOf('truth-owner-a'))!,
    path,
    scopeOf('truth-owner-b')
  )
  reconcileNativeChatStagedDraft(scopeOf('truth-owner-b'), {
    text: '',
    images: [{ id: path, path }]
  })
  expect(nativeChatStagedOwnershipVersion()).toBeGreaterThan(before)
  expect(now('truth-refusing-b')).toEqual({
    held: { count: 1, ownerSessionId: 'truth-owner-b' },
    gone: []
  })

  reconcileNativeChatStagedDraft(scopeOf('truth-owner-b'), { text: '', images: [] })
  expect(now('truth-refusing-b')).toEqual({ held: null, gone: [path] })
})

// A shown notice reads the drafts once per ownership change: the same result until one happens.
it('reads the drafts again only when ownership changes', () => {
  const path = 'blob:truth-cached'
  inDraftOf('truth-owner-c', path)
  nativeChatBrowserFileRefusal([path], 'truth-refusing-c')
  const record = readNativeChatHeldElsewhere('truth-refusing-c')!

  const version = nativeChatStagedOwnershipVersion()
  const first = nativeChatHeldElsewhereAt(record, 'truth-refusing-c', version)
  expect(nativeChatHeldElsewhereAt(record, 'truth-refusing-c', version)).toBe(first)
  reconcileNativeChatStagedDraft(scopeOf('truth-owner-c'), { text: '', images: [] })
  const next = nativeChatHeldElsewhereAt(
    record,
    'truth-refusing-c',
    nativeChatStagedOwnershipVersion()
  )
  expect(next).not.toBe(first)
  expect(next.held).toBeNull()
})

const tab = (id: string, worktreeId: string, entityId: string): Tab =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads only these fields.
  ({ id, worktreeId, entityId, contentType: 'agent-session', label: id }) as unknown as Tab

// The jump goes to the one open tab of the owning chat, in whatever workspace; two tabs of the same
// conversation (a paired twin) are ambiguous, and neither is offered.
it('finds the one owning tab across workspaces and offers none for a twin', () => {
  const owner = tab('owner-tab', 'wt-other', 'truth-owner')
  expect(
    nativeChatHeldElsewhereOwnerTab(
      { 'wt-here': [tab('mine', 'wt-here', 'me')], 'wt-other': [owner] },
      'truth-owner'
    )
  ).toBe(owner)
  expect(
    nativeChatHeldElsewhereOwnerTab(
      { 'wt-other': [owner], 'wt-twin': [tab('twin-tab', 'wt-twin', 'truth-owner')] },
      'truth-owner'
    )
  ).toBeNull()
  expect(nativeChatHeldElsewhereOwnerTab({ 'wt-here': [] }, 'truth-owner')).toBeNull()
})

// D12-05. A closed chat's account ends with it: records do not outlive their chats.
it('retires the account when its chat closes', () => {
  const path = 'blob:truth-close'
  inDraftOf('truth-owner-d', path)
  nativeChatBrowserFileRefusal([path], 'truth-refusing-d')
  expect(nativeChatHeldElsewhereRecordCountForTests()).toBe(1)

  discardStructuredAgentSessionChatSends('truth-refusing-d')

  expect(readNativeChatHeldElsewhere('truth-refusing-d')).toBeNull()
  expect(nativeChatHeldElsewhereRecordCountForTests()).toBe(0)
})

// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

// The host upload boundary is the only stand-in: browser files, staging, the send lease, the hand-back,
// the draft store and the first-send plan all run for real.
const uploadedSources: string[] = []
// Host path → staged original, for every upload the stand-in host made.
const uploadedHosts = new Map<string, string>()
let nextUpload = 0
vi.mock('../attachments/uploads/native-chat-attachment-owner', () => ({
  resolveNativeChatRuntimeSessionAttachmentOwner: (session: { sessionId: string }) => ({
    kind: 'runtime-session',
    environmentId: 'env',
    sessionId: session.sessionId
  })
}))
vi.mock('../attachments/uploads/native-chat-session-attachment-upload', () => ({
  prepareNativeChatSessionAttachmentUpload: async (owner: { sessionId: string }) => ({
    ok: true,
    target: { environmentId: 'env', sessionId: owner.sessionId, expectedEnvironmentRuntimeId: 'rt' }
  }),
  uploadNativeChatSessionAttachmentPaths: async (paths: string[]) => {
    uploadedSources.push(...paths)
    return {
      uploaded: paths.map((sourcePath) => {
        const path = `/host/agent-session-attachments/restore${nextUpload++}/file.png`
        uploadedHosts.set(path, sourcePath)
        return { sourcePath, path }
      }),
      failed: []
    }
  }
}))

const { holdBrowserAttachmentFiles, takeBrowserAttachmentFile } =
  await import('@/lib/files/drop/browser-attachment-files')
const { reconcileNativeChatStagedDraft, stageNativeChatDraftFile, stagedNativeChatFiles } =
  await import('./native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput } = await import('./native-chat-staged-input')
const { readNativeChatComposerDraft } = await import('./native-chat-composer-draft-store')
const { structuredAgentSessionDraftScopeKey } = await import('./native-chat-draft-scope')
const { handBackStructuredAgentSessionMessage, returnMessageToComposer } =
  await import('../session/structured/delivery/structured-agent-session-message-hand-back')
const { agentSessionAttachmentUploadIdOfPath } =
  await import('../../../../../shared/agent-session/agent-session-attachments')
const { formatNativeChatFileReference } =
  await import('../../../../../shared/native-chat/input/composer/agent-image-paste')
const { worktreeCreationFirstSend } =
  await import('@/lib/workspace/creation/worktree-creation-first-send')
const { reserveStructuredAgentSessionSend } =
  await import('../session/structured/delivery/structured-agent-session-message-sender')
const { handBackRefused } =
  await import('../session/structured/delivery/structured-agent-session-send-runtime')
const { findStructuredAgentSessionPendingSend, getStructuredAgentSessionSendNotice } =
  await import('../session/structured/delivery/structured-agent-session-pending-sends')
const { agentSessionWriteNotDoneParts } =
  await import('../../../../../shared/agent-session/failures/agent-session-refusal-notice')
const { agentSessionWriteNoticeText } =
  await import('../messages/notices/agent-session-write-notice-text')

beforeEach(() => {
  uploadedSources.length = 0
})

const session = { runtimeEnvironmentId: 'env' }
const uploadIdOf = (host: string): string => agentSessionAttachmentUploadIdOfPath(host)!
const hostOf = (original: string): string =>
  [...uploadedHosts].find(([, from]) => from === original)![0]

/**
 * A pending creation's first send: an image, a file named in its text, and a sibling image, all
 * browser files staged at the source. It is planned as the creation plans it, uploaded for
 * `sessionId`, and the sent message leaves the source composer.
 */
const firstSendFromPendingSource = async (name: string) => {
  const sessionId = `restore-${name}`
  const source = `pending-creation:restore-${name}`
  const recipient = structuredAgentSessionDraftScopeKey(sessionId)
  const [image, text, sibling] = holdBrowserAttachmentFiles(
    ['image.png', 'notes.txt', 'sibling.png'].map((file) => new File([file], file))
  )
  ;[image, text, sibling].forEach((path) => stageNativeChatDraftFile(source, path))
  const request = { quickPrompt: `see ${formatNativeChatFileReference(text)}` }
  const pending = {
    heldChatAttachments: [
      { id: 'image', path: image },
      { id: 'sibling', path: sibling }
    ]
  }
  const first = worktreeCreationFirstSend(source, request, pending)
  const send = captureNativeChatStagedInput(source, first)
  reconcileNativeChatStagedDraft(source, { text: '', images: [] })
  const prepared = await send.prepare(first, { ...session, sessionId })
  uploadedSources.length = 0
  return {
    sessionId,
    source,
    recipient,
    image,
    text,
    sibling,
    request,
    pending,
    first,
    prepared,
    imageHost: hostOf(image),
    textHost: hostOf(text),
    siblingHost: hostOf(sibling)
  }
}
type FirstSend = Awaited<ReturnType<typeof firstSendFromPendingSource>>

/** The host refused the prepared first send because the image and file uploads expired. */
const refusedMessage = (sent: FirstSend): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'text', text: sent.prepared.text },
    { type: 'image-ref', path: sent.imageHost },
    { type: 'image-ref', path: sent.siblingHost }
  ]
})
const expiredOf = (sent: FirstSend): Set<string> =>
  new Set([uploadIdOf(sent.imageHost), uploadIdOf(sent.textHost)])

// One ownership rule for a restored browser file: once the chat a refusal returned it to holds it, that
// chat owns it and the pending source does not. The source's Retry (planned exactly as the creation
// plans it) leaves it out, attachment and text reference alike, so nothing it sends names a
// renderer-only file; the recipient keeps it whole and uploads it on its own Send.
it('leaves an adopted browser file out of the source Retry and keeps it whole in the recipient', async () => {
  const sent = await firstSendFromPendingSource('retry')
  expect(sent.first.attachments?.map(({ path }) => path)).toEqual([sent.image, sent.sibling])

  handBackStructuredAgentSessionMessage(
    sent.sessionId,
    'first',
    refusedMessage(sent),
    undefined,
    expiredOf(sent)
  )

  const retry = worktreeCreationFirstSend(sent.source, sent.request, sent.pending)
  const outgoing = await captureNativeChatStagedInput(sent.source, retry).prepare(retry, {
    ...session,
    sessionId: sent.sessionId
  })
  const shipped = [outgoing.text, ...(outgoing.attachments ?? []).map(({ path }) => path)]
  expect(shipped.join(' ')).not.toContain('orca-browser-file:')
  expect(outgoing.attachments?.map(({ path }) => path)).toEqual([sent.siblingHost])
  expect(outgoing.text).not.toContain(sent.textHost)
  expect(uploadedSources).toEqual([])

  const returned = readNativeChatComposerDraft(sent.recipient)
  expect(returned.images.map(({ path }) => path)).toEqual([sent.image, sent.siblingHost])
  expect(returned.text).toContain(formatNativeChatFileReference(sent.text))
  const own = { text: returned.text, attachments: [{ path: sent.image }] }
  const resent = await captureNativeChatStagedInput(sent.recipient, own).prepare(own, {
    ...session,
    sessionId: sent.sessionId
  })
  expect(uploadedSources.sort()).toEqual([sent.image, sent.text].sort())
  expect(JSON.stringify(resent)).not.toContain('orca-browser-file:')
})

// A browser file whose bytes are gone cannot come back as itself: it keeps the existing unavailable
// chip, and the source keeps what it staged (nothing moved to a chat that could not read it).
it('does not restore a browser file whose bytes are gone', async () => {
  const sent = await firstSendFromPendingSource('bytes')
  takeBrowserAttachmentFile(sent.image)

  handBackStructuredAgentSessionMessage(
    sent.sessionId,
    'first',
    refusedMessage(sent),
    undefined,
    expiredOf(sent)
  )

  const returned = readNativeChatComposerDraft(sent.recipient)
  expect(returned.images[0]).toMatchObject({ path: '' })
  expect(returned.images[0].unavailableName).toBeDefined()
  expect(returned.images.map(({ path }) => path)).not.toContain(sent.image)
  expect(stagedNativeChatFiles(sent.source)?.paths.has(sent.image)).toBe(true)
  expect(returned.text).toContain(formatNativeChatFileReference(sent.text))
})

// Restoring forgets only the cached upload that produced the expired one: a newer upload of the same
// original (made since) stays and goes with it, so the recipient's Send reuses it instead of uploading.
it('keeps a newer cached upload of a restored original', async () => {
  const sent = await firstSendFromPendingSource('competing')
  const newer = '/host/agent-session-attachments/newer/file.png'
  const cache = [...stagedNativeChatFiles(sent.source)!.uploads.values()][0]
  cache.set(sent.image, Promise.resolve(newer))

  handBackStructuredAgentSessionMessage(
    sent.sessionId,
    'first',
    refusedMessage(sent),
    undefined,
    expiredOf(sent)
  )

  const returned = readNativeChatComposerDraft(sent.recipient)
  expect(returned.images.map(({ path }) => path)).toContain(sent.image)
  const own = { text: '', attachments: [{ path: sent.image }] }
  const resent = await captureNativeChatStagedInput(sent.recipient, own).prepare(own, {
    ...session,
    sessionId: sent.sessionId
  })
  expect(resent.attachments?.map(({ path }) => path)).toEqual([newer])
  expect(uploadedSources).toEqual([])
})

// Ownership moves only into a draft that actually holds the returned original: a hand-back whose draft
// was never installed (a queued edit with no open editor) takes nothing, and the source keeps it all.
it('takes no ownership when the returned draft was not installed', async () => {
  const sent = await firstSendFromPendingSource('uninstalled')
  const nowhere = 'queued-edit:restore-uninstalled'
  const restored = new Set<string>()

  returnMessageToComposer(
    nowhere,
    'returned-nowhere',
    refusedMessage(sent).blocks,
    undefined,
    expiredOf(sent),
    undefined,
    sent.sessionId,
    restored
  )

  expect(readNativeChatComposerDraft(nowhere).images).toEqual([])
  expect(restored.size).toBe(0)
  expect(stagedNativeChatFiles(nowhere)).toBeUndefined()
  const owned = stagedNativeChatFiles(sent.source)?.paths
  expect([sent.image, sent.text].every((path) => owned?.has(path))).toBe(true)
})

// The notice says what is still missing: only the expired attachments that did not come back as their
// originals are named for attaching again; when every one came back, it is the ordinary "not sent".
it('names only the unrecovered expired attachments in the refusal notice', async () => {
  const words = (sessionId: string) => getStructuredAgentSessionSendNotice(sessionId) ?? ''
  const refuse = (sent: FirstSend) => {
    const slot = reserveStructuredAgentSessionSend({
      sessionId: sent.sessionId,
      text: sent.prepared.text,
      attachments: [sent.imageHost, sent.siblingHost].map((path) => ({ path, previewUri: '' }))
    })!
    handBackRefused(findStructuredAgentSessionPendingSend(sent.sessionId, slot.clientMessageId)!, {
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: {
        expiredAttachments: [
          { uploadId: uploadIdOf(sent.imageHost), name: 'image-upload.png' },
          { uploadId: uploadIdOf(sent.textHost), name: 'notes-upload.txt' }
        ]
      }
    })
  }

  const partly = await firstSendFromPendingSource('notice-partly')
  takeBrowserAttachmentFile(partly.image)
  refuse(partly)
  expect(words(partly.sessionId)).toContain('image-upload.png')
  expect(words(partly.sessionId)).not.toContain('notes-upload.txt')

  const fully = await firstSendFromPendingSource('notice-fully')
  refuse(fully)
  expect(words(fully.sessionId)).toBe(
    agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('composer-send'))
  )
})

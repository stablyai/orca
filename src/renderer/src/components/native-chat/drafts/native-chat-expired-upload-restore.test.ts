// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

// The host upload boundary is the only stand-in: browser files, staging, the send lease, the hand-back,
// the draft store and the first-send plan all run for real.
const uploadedSources: string[] = []
// Host path → staged original, for every upload the stand-in host made.
const uploadedHosts = new Map<string, string>()
let nextUpload = 0
// A new runtime id is a new upload target (cache key) for the same conversation.
let runtimeId = 'rt'
// Set to hold the next upload until the test settles it (true: it uploads; false: it fails).
let holdUpload = false
let settleHeldUpload: ((uploads: boolean) => void) | undefined
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
    target: {
      environmentId: 'env',
      sessionId: owner.sessionId,
      expectedEnvironmentRuntimeId: runtimeId
    }
  }),
  uploadNativeChatSessionAttachmentPaths: async (paths: string[]) => {
    uploadedSources.push(...paths)
    if (holdUpload) {
      holdUpload = false
      const uploads = await new Promise<boolean>((resolve) => (settleHeldUpload = resolve))
      if (!uploads) {
        throw new Error('The upload failed.')
      }
    }
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
/** The host path of an upload of `original`: its first, or (-1) its latest. */
const hostOf = (original: string, which: 0 | -1 = 0): string =>
  [...uploadedHosts].filter(([, from]) => from === original).at(which)![0]

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
  // The plan itself is what goes out when the source has nothing left to prepare.
  expect(retry.attachments?.map(({ path }) => path)).toEqual([sent.sibling])
  expect(retry.text).not.toContain(sent.text)
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

/** The old send's late refusal: its image and file uploads expired, and the hand-back adopts them. */
const lateRefusal = (sent: FirstSend) =>
  handBackStructuredAgentSessionMessage(
    sent.sessionId,
    'late',
    refusedMessage(sent),
    undefined,
    expiredOf(sent)
  )
const browserTokensIn = (input: { text: string; attachments?: readonly { path: string }[] }) =>
  [input.text, ...(input.attachments ?? []).map(({ path }) => path)].join(' ')

// The fail-closed invariant at the boundary where the payload leaves: a Retry planned while the source
// still owned its browser files is prepared after the old send's late refusal gave them to the old
// chat. What goes out holds no browser-file reference the sending staging does not own at that moment,
// attachment or text reference, with a healthy sibling (uploaded and sent) and without one (nothing left).
it('never lets a browser file adopted after the plan leave in the prepared payload', async () => {
  const sent = await firstSendFromPendingSource('late')
  const retry = worktreeCreationFirstSend(sent.source, sent.request, sent.pending)
  expect(retry.attachments?.map(({ path }) => path)).toEqual([sent.image, sent.sibling])
  const withSibling = captureNativeChatStagedInput(sent.source, retry)
  const alone = { text: '', attachments: [{ path: sent.image }] }
  const withoutSibling = captureNativeChatStagedInput(sent.source, alone)

  lateRefusal(sent)

  const retrySession = { ...session, sessionId: `${sent.sessionId}-retry` }
  const outgoing = await withSibling.prepare(retry, retrySession)
  expect(browserTokensIn(outgoing)).not.toContain('orca-browser-file:')
  expect(outgoing.attachments?.map(({ path }) => path)).toEqual([hostOf(sent.sibling, -1)])
  expect(uploadedSources).toEqual([sent.sibling])

  const nothing = await withoutSibling.prepare(alone, retrySession)
  expect(nothing).toMatchObject({ text: '', attachments: [] })
  expect(readNativeChatComposerDraft(sent.recipient).images.map(({ path }) => path)).toContain(
    sent.image
  )
})

// An upload still in flight when its original is adopted settles with the staging that holds it then:
// its record lands in the recipient, and a failure removes the recipient's cached promise, so the
// recipient's next Send uploads afresh instead of reusing a failed upload.
it('settles an upload in flight at adoption with the staging that holds it', async () => {
  const done = await firstSendFromPendingSource('in-flight-done')
  const otherDone = { ...session, sessionId: `${done.sessionId}-other` }
  const input = { text: '', attachments: [{ path: done.image }] }
  holdUpload = true
  const preparing = captureNativeChatStagedInput(done.source, input).prepare(input, otherDone)
  await vi.waitFor(() => expect(settleHeldUpload).toBeDefined())
  lateRefusal(done)
  settleHeldUpload!(true)
  settleHeldUpload = undefined
  const host = (await preparing).attachments![0].path
  expect(stagedNativeChatFiles(done.recipient)?.uploaded.get(host)).toMatchObject({
    source: done.image,
    sessionId: otherDone.sessionId
  })
  expect(stagedNativeChatFiles(done.source)?.uploaded.has(host)).toBeFalsy()

  const failed = await firstSendFromPendingSource('in-flight-failed')
  const otherFailed = { ...session, sessionId: `${failed.sessionId}-other` }
  const again = { text: '', attachments: [{ path: failed.image }] }
  holdUpload = true
  const failing = captureNativeChatStagedInput(failed.source, again).prepare(again, otherFailed)
  await vi.waitFor(() => expect(settleHeldUpload).toBeDefined())
  lateRefusal(failed)
  settleHeldUpload!(false)
  settleHeldUpload = undefined
  await expect(failing).rejects.toThrow('The upload failed.')
  const cached = [...stagedNativeChatFiles(failed.recipient)!.uploads.values()]
  expect(cached.some((uploads) => uploads.has(failed.image))).toBe(false)
})

// Two expired uploads of one original (two upload targets of the same conversation) both come back as
// that original, and both count as recovered: the notice is the ordinary "not sent", naming neither.
it('counts both expired uploads of one original as recovered', async () => {
  const sent = await firstSendFromPendingSource('twice')
  runtimeId = 'rt-twice'
  const again = { text: '', attachments: [{ path: sent.image }] }
  const second = await captureNativeChatStagedInput(sent.source, again).prepare(again, {
    ...session,
    sessionId: sent.sessionId
  })
  runtimeId = 'rt'
  const secondHost = second.attachments![0].path
  expect(secondHost).not.toBe(sent.imageHost)

  const slot = reserveStructuredAgentSessionSend({
    sessionId: sent.sessionId,
    text: `see ${formatNativeChatFileReference(secondHost)}`,
    attachments: [{ path: sent.imageHost, previewUri: '' }]
  })!
  handBackRefused(findStructuredAgentSessionPendingSend(sent.sessionId, slot.clientMessageId)!, {
    kind: 'refused',
    code: 'agent_session_operation_invalid',
    details: {
      expiredAttachments: [
        { uploadId: uploadIdOf(sent.imageHost), name: 'first-upload.png' },
        { uploadId: uploadIdOf(secondHost), name: 'second-upload.png' }
      ]
    }
  })

  const returned = readNativeChatComposerDraft(sent.recipient)
  expect(returned.images.map(({ path }) => path)).toEqual([sent.image])
  expect(returned.text).toContain(formatNativeChatFileReference(sent.image))
  expect(getStructuredAgentSessionSendNotice(sent.sessionId)).toBe(
    agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('composer-send'))
  )
})

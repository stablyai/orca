// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'

// The browser token store and the host upload boundary are the only stand-ins: staging, the send
// lease, the hand-back and draft removal all run for real.
const released: string[] = []
const uploadedSources: string[] = []
// Host path → staged original, for every upload the stand-in host made.
const uploadedHosts = new Map<string, string>()
let nextUpload = 0
vi.mock('@/lib/files/drop/browser-attachment-files', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserAttachmentFiles>()),
  releaseBrowserAttachmentFiles: (paths: readonly string[]) => released.push(...paths)
}))
vi.mock('../attachments/uploads/native-chat-attachment-owner', () => ({
  resolveNativeChatRuntimeSessionAttachmentOwner: (session: { sessionId: string }) => ({
    kind: 'runtime-session',
    environmentId: 'env',
    sessionId: session.sessionId
  })
}))
// Like the real one, the upload target names the conversation the upload is for.
vi.mock('../attachments/uploads/native-chat-session-attachment-upload', () => ({
  prepareNativeChatSessionAttachmentUpload: async (owner: { sessionId: string }) => ({
    ok: true,
    target: { environmentId: 'env', sessionId: owner.sessionId, expectedEnvironmentRuntimeId: 'rt' }
  }),
  uploadNativeChatSessionAttachmentPaths: async (paths: string[]) => {
    uploadedSources.push(...paths)
    return {
      uploaded: paths.map((sourcePath) => {
        const path = `/host/agent-session-attachments/upload${nextUpload++}/file.png`
        uploadedHosts.set(path, sourcePath)
        return { sourcePath, path }
      }),
      failed: []
    }
  }
}))

const { reconcileNativeChatStagedDraft, stageNativeChatDraftFile } =
  await import('./native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput } = await import('./native-chat-staged-input')
const { readNativeChatComposerDraft, updateNativeChatComposerDraft } =
  await import('./native-chat-composer-draft-store')
const { nativeChatDraftPositions, records } = await import('./native-chat-composer-draft-memory')
const { deleteNativeChatComposerDraft } = await import('./native-chat-composer-draft-removal')
const { structuredAgentSessionDraftScopeKey } = await import('./native-chat-draft-scope')
const { handBackStructuredAgentSessionMessage } =
  await import('../session/structured/delivery/structured-agent-session-message-hand-back')
const { agentSessionAttachmentUploadIdOfPath } =
  await import('../../../../../shared/agent-session/agent-session-attachments')
const { moveNativeChatComposerDraft } = await import('./native-chat-composer-draft-move')
const { discardStructuredAgentSessionChatSends } =
  await import('@/lib/agent-session/launch/structured-agent-session-staged-prompt')
const { formatNativeChatFileReference } =
  await import('../../../../../shared/native-chat/input/composer/agent-image-paste')

beforeEach(() => {
  released.length = 0
  uploadedSources.length = 0
})

const session = { runtimeEnvironmentId: 'env' }
const sendAndRefuse = async (sessionId: string, expiredIndexes: number[]) => {
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const originals = [`blob:${sessionId}-a`, `blob:${sessionId}-b`]
  originals.forEach((path) => stageNativeChatDraftFile(scope, path))
  const input = { text: '', attachments: originals.map((path) => ({ path })) }
  const send = captureNativeChatStagedInput(scope, input)
  // The sent message left the composer: only the send lease keeps the originals now.
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  const prepared = await send.prepare(input, { ...session, sessionId })
  const hosts = prepared.attachments!.map(({ path }) => path)
  // Not delivered after a confirmed handoff: release waits for the draft to hold the files.
  send.releaseWhenHeld()
  const refused: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: hosts.map((path) => ({ type: 'image-ref', path }))
  }
  handBackStructuredAgentSessionMessage(
    sessionId,
    'refused',
    refused,
    undefined,
    new Set(expiredIndexes.map((index) => agentSessionAttachmentUploadIdOfPath(hosts[index])!))
  )
  return { scope, originals, hosts, input }
}

// A send refused for an expired upload comes back holding the original file, not an unavailable chip;
// only that upload is forgotten, so the next send uploads it afresh and reuses the healthy one.
it('returns an expired upload as its original and uploads only that one again', async () => {
  const { scope, originals, hosts, input } = await sendAndRefuse('staged-expiry', [0])

  expect(readNativeChatComposerDraft(scope).images.map(({ path }) => path)).toEqual([
    originals[0],
    hosts[1]
  ])
  expect(released).not.toContain(originals[0])

  uploadedSources.length = 0
  const resend = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: originals[0] }]
  })
  await resend.prepare(
    { text: '', attachments: [{ path: originals[0] }] },
    { ...session, sessionId: 'staged-expiry' }
  )
  expect(uploadedSources).toEqual([originals[0]])
  expect(input.attachments).toHaveLength(2)
})

// Once the draft holds every submitted file (the original itself, or a live upload of it) the send lease
// ends: the original behind a live upload is released as redundant, the returned original stays.
it('releases an original once the draft holds a live upload of it, keeping the returned one', async () => {
  const { originals } = await sendAndRefuse('staged-custody', [0])

  expect(released).toContain(originals[1])
  expect(released).not.toContain(originals[0])
})

// Deliberately deleting a draft also releases files staged for it when no draft record or subscriber
// remains, such as a provisional destination.
it('releases staged-only files when their draft is deleted', () => {
  const scope = 'staged-only-destination'
  stageNativeChatDraftFile(scope, 'blob:staged-only')

  deleteNativeChatComposerDraft(scope)

  expect(released).toContain('blob:staged-only')
})

/**
 * Paired worktree creation: stage the first send at the pending source, upload it for `sessionId`, and
 * have the host refuse it for the expired `expiredOf` originals while the files are still at the source.
 */
const refuseFirstSendBeforeHandoff = async (
  name: string,
  options: { refusedIn?: string; skills?: AgentJournalMessageItem['skills'] } = {}
) => {
  const sessionId = `staged-early-${name}`
  const source = `pending-creation:staged-early-${name}`
  const recipient = structuredAgentSessionDraftScopeKey(options.refusedIn ?? sessionId)
  const [image, text, sibling] = ['image', 'text', 'sibling'].map((kind) => `blob:${name}-${kind}`)
  ;[image, text, sibling].forEach((path) => stageNativeChatDraftFile(source, path))
  const input = {
    text: `see ${formatNativeChatFileReference(text)}`,
    attachments: [{ path: image }, { path: sibling }]
  }
  const send = captureNativeChatStagedInput(source, input)
  reconcileNativeChatStagedDraft(source, { text: '', images: [] })
  const prepared = await send.prepare(input, { ...session, sessionId })
  const [imageHost, siblingHost] = prepared.attachments!.map(({ path }) => path)
  const textHost = [...uploadedHosts.entries()].find(([, from]) => from === text)![0]
  const refused: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: options.skills ? `/review-skill ${prepared.text}` : prepared.text },
      { type: 'image-ref', path: imageHost },
      { type: 'image-ref', path: siblingHost }
    ],
    ...(options.skills ? { skills: options.skills } : {})
  }
  const expired = [imageHost, textHost].map((host) => agentSessionAttachmentUploadIdOfPath(host)!)
  handBackStructuredAgentSessionMessage(
    options.refusedIn ?? sessionId,
    'early',
    refused,
    undefined,
    new Set(expired)
  )
  return { sessionId, source, recipient, image, text, imageHost, textHost, siblingHost }
}

// A first send refused for expiry before its draft moved in is restored by the hand-back itself, from
// the upload's own record: the chat gets the original image and file reference at once and owns them
// (an early Send uploads them, the source's dismissal cannot release them); the move then adds nothing
// to the returned content, and the healthy sibling keeps its host upload.
it('restores a first send refused for expiry before its draft moved, at hand-back', async () => {
  const early = await refuseFirstSendBeforeHandoff('restored')
  const returned = readNativeChatComposerDraft(early.recipient)
  expect(returned.images.map(({ path }) => path)).toEqual([early.image, early.siblingHost])
  expect(returned.text).toContain(formatNativeChatFileReference(early.text))
  expect(returned.text).not.toContain(early.textHost)

  uploadedSources.length = 0
  const resend = {
    text: returned.text,
    attachments: [{ path: early.image }, { path: early.siblingHost }]
  }
  await captureNativeChatStagedInput(early.recipient, resend).prepare(resend, {
    ...session,
    sessionId: early.sessionId
  })
  expect(uploadedSources.sort()).toEqual([early.image, early.text].sort())

  deleteNativeChatComposerDraft(early.source)
  expect(released).not.toContain(early.image)
  expect(released).not.toContain(early.text)
})

// The upload record names its conversation: a refusal handed back to a different conversation never
// takes those bytes; it shows the existing unavailable chip, and the original stays where it was.
it('does not restore an expired upload made for another conversation', async () => {
  const other = await refuseFirstSendBeforeHandoff('foreign', { refusedIn: 'someone-else' })
  const returned = readNativeChatComposerDraft(other.recipient)
  expect(returned.images[0]).toMatchObject({ path: '' })
  expect(returned.images[0].unavailableName).toBeDefined()
  expect(returned.text).toContain(other.textHost)

  uploadedSources.length = 0
  const own = { text: '', attachments: [{ path: other.image }] }
  await captureNativeChatStagedInput(other.source, own).prepare(own, {
    ...session,
    sessionId: other.sessionId
  })
  expect(uploadedSources).toEqual([])
})

// Closing a provisional chat before it was created discards its sends, so nothing will hand a moved
// first send back: its waiting lease ends and the originals no draft holds are released.
it('releases a moved first send waiting for custody when its provisional chat is discarded', () => {
  const sessionId = 'staged-provisional-discard'
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  stageNativeChatDraftFile(scope, 'blob:provisional')
  const input = { text: '', attachments: [{ path: 'blob:provisional' }] }
  const send = captureNativeChatStagedInput(scope, input)
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  send.releaseWhenHeld()
  expect(released).not.toContain('blob:provisional')

  discardStructuredAgentSessionChatSends(sessionId)

  expect(released).toContain('blob:provisional')
})

// Nothing rewrites a draft after the hand-back: the person removes the returned reference, and the
// pending source brings its own text naming the same expired host path (and a longer sibling path);
// the move appends that text exactly as it was, and its originals are not reused for it.
it('never rewrites source content the move brings in', async () => {
  const early = await refuseFirstSendBeforeHandoff('appended')
  updateNativeChatComposerDraft(early.recipient, { text: 'mine', document: undefined }, 'immediate')
  const incoming = `also ${formatNativeChatFileReference(early.textHost)} and ${formatNativeChatFileReference(`${early.textHost}.bak`)}`
  updateNativeChatComposerDraft(early.source, { text: incoming }, 'immediate')

  moveNativeChatComposerDraft(early.source, early.recipient, {
    workspaceId: 'wt',
    executionHostId: 'local'
  })

  const moved = readNativeChatComposerDraft(early.recipient)
  expect(moved.text).toContain('mine')
  expect(moved.text).toContain(incoming)
  expect(moved.text).not.toContain(formatNativeChatFileReference(early.text))
})

// The move's pending caret is the last word on the moved draft: no later write moves or retires it.
it('keeps the move pending caret exactly where the move put it', async () => {
  const early = await refuseFirstSendBeforeHandoff('caret')
  updateNativeChatComposerDraft(early.source, { text: 'typed later' }, 'immediate')
  let placed = -1
  const position = (merged: { text: string }) => {
    placed = merged.text.length
    return { at: 'selection' as const, from: placed, to: placed, pending: true }
  }

  moveNativeChatComposerDraft(early.source, early.recipient, undefined, position)

  const record = records.get(early.recipient)
  const carried = record && nativeChatDraftPositions.get(record)
  expect(carried).toMatchObject({ at: 'selection', from: placed, to: placed, pending: true })
  expect(readNativeChatComposerDraft(early.recipient).text.length).toBe(placed)
})

// The restored message is built once, from Orca's own parts: its text and its rich document agree, the
// selected skill keeps its path, and neither names the expired host path.
it('builds the restored text and document from the same parts, keeping a selected skill', async () => {
  const skill = { name: 'review-skill', path: '/skills/review/SKILL.md' }
  const early = await refuseFirstSendBeforeHandoff('document', { skills: [skill] })
  const returned = readNativeChatComposerDraft(early.recipient)
  const document = JSON.stringify(returned.document)
  expect(returned.text).toContain(formatNativeChatFileReference(early.text))
  expect(document).toContain(skill.path)
  expect(document).toContain(early.text)
  expect(document).not.toContain(early.textHost)
  expect(returned.text).not.toContain(early.textHost)
})

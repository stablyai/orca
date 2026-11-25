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
  resolveNativeChatRuntimeSessionAttachmentOwner: () => ({
    kind: 'runtime-session',
    environmentId: 'env'
  })
}))
vi.mock('../attachments/uploads/native-chat-session-attachment-upload', () => ({
  prepareNativeChatSessionAttachmentUpload: async () => ({ ok: true, target: { host: 'env' } }),
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
const {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} = await import('./native-chat-composer-draft-store')
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

// Paired worktree creation: the first send is refused for expired uploads while its files are still
// staged at the pending source. The hand-back can only offer "attach again" then; when the draft moves
// into the chat, the originals it brings repair the returned image and file reference, so Send uploads
// them afresh and reuses the healthy sibling's upload.
it('repairs a first send refused for expiry before its draft moved into the chat', async () => {
  const sessionId = 'staged-before-handoff'
  const source = 'pending-creation:staged-before-handoff'
  const recipient = structuredAgentSessionDraftScopeKey(sessionId)
  const [image, text, sibling] = ['blob:pre-image', 'blob:pre-text', 'blob:pre-sibling']
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
      { type: 'text', text: prepared.text },
      { type: 'image-ref', path: imageHost },
      { type: 'image-ref', path: siblingHost }
    ]
  }
  const expired = [imageHost, textHost].map((host) => agentSessionAttachmentUploadIdOfPath(host)!)
  handBackStructuredAgentSessionMessage(sessionId, 'early', refused, undefined, new Set(expired))
  expect(readNativeChatComposerDraft(recipient).images[0].unavailableName).toBeDefined()

  moveNativeChatComposerDraft(source, recipient, { workspaceId: 'wt', executionHostId: 'local' })

  const repaired = readNativeChatComposerDraft(recipient)
  expect(repaired.images.map(({ path }) => path)).toEqual([image, siblingHost])
  expect(repaired.text).toContain(formatNativeChatFileReference(text))
  expect(repaired.text).not.toContain(textHost)
  uploadedSources.length = 0
  const resend = { text: repaired.text, attachments: [{ path: image }, { path: siblingHost }] }
  await captureNativeChatStagedInput(recipient, resend).prepare(resend, { ...session, sessionId })
  expect(uploadedSources.sort()).toEqual([image, text].sort())
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

// The repair follows the unresolved reference, not the chip id: if the user put a newer image of the
// same name in the unavailable slot before the draft moved in, that image stays. The expired text
// reference is still repaired, and the stored rich document (its selected skill) survives the rewrite.
it('keeps a newer image put in the unavailable slot and the draft document when repairing', async () => {
  const sessionId = 'staged-replaced-before-handoff'
  const source = 'pending-creation:staged-replaced-before-handoff'
  const recipient = structuredAgentSessionDraftScopeKey(sessionId)
  const [image, text] = ['blob:replaced-image', 'blob:replaced-text']
  ;[image, text].forEach((path) => stageNativeChatDraftFile(source, path))
  const input = { text: formatNativeChatFileReference(text), attachments: [{ path: image }] }
  const send = captureNativeChatStagedInput(source, input)
  reconcileNativeChatStagedDraft(source, { text: '', images: [] })
  const prepared = await send.prepare(input, { ...session, sessionId })
  const imageHost = prepared.attachments![0].path
  const textHost = [...uploadedHosts.entries()].find(([, from]) => from === text)![0]
  const skill = { name: 'review-skill', path: '/skills/review/SKILL.md' }
  const refused: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: `/review-skill ${prepared.text}` },
      { type: 'image-ref', path: imageHost }
    ],
    skills: [skill]
  }
  const expired = [imageHost, textHost].map((host) => agentSessionAttachmentUploadIdOfPath(host)!)
  handBackStructuredAgentSessionMessage(sessionId, 'replaced', refused, undefined, new Set(expired))
  const newer = '/picked/again/file.png'
  appendToNativeChatComposerDraft(recipient, {
    images: [{ id: 'picked', path: newer }],
    fromUser: true
  })
  expect(readNativeChatComposerDraft(recipient).images.map(({ path }) => path)).toEqual([newer])

  moveNativeChatComposerDraft(source, recipient, { workspaceId: 'wt', executionHostId: 'local' })

  const repaired = readNativeChatComposerDraft(recipient)
  expect(repaired.images.map(({ path }) => path)).toEqual([newer])
  expect(repaired.text).toContain(formatNativeChatFileReference(text))
  const document = JSON.stringify(repaired.document)
  expect(document).toContain(skill.path)
  expect(document).toContain(text)
  expect(document).not.toContain(textHost)
})

/** Refuse a first send for its expired text file before the draft moves, then return the host path. */
const refuseTextBeforeHandoff = async (name: string) => {
  const sessionId = `staged-exact-${name}`
  const source = `pending-creation:staged-exact-${name}`
  const recipient = structuredAgentSessionDraftScopeKey(sessionId)
  const text = `blob:exact-${name}`
  stageNativeChatDraftFile(source, text)
  const input = { text: formatNativeChatFileReference(text) }
  const send = captureNativeChatStagedInput(source, input)
  reconcileNativeChatStagedDraft(source, { text: '', images: [] })
  await send.prepare(input, { ...session, sessionId })
  const host = [...uploadedHosts.entries()].find(([, from]) => from === text)![0]
  const refused: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: formatNativeChatFileReference(host) }]
  }
  const expired = new Set([agentSessionAttachmentUploadIdOfPath(host)!])
  handBackStructuredAgentSessionMessage(sessionId, 'exact', refused, undefined, expired)
  return { source, recipient, text, host }
}

const fileAtom = (path: string) => ({
  type: 'nativeChatFileReference',
  attrs: { token: formatNativeChatFileReference(path), path }
})

// Only the exact expired reference is repaired: a longer sibling path (`….bak`), prose quoting the
// path and a file atom for the sibling stay exactly as the person left them, in text and document.
it('repairs only the exact expired reference, not a longer path or quoted prose', async () => {
  const { source, recipient, text, host } = await refuseTextBeforeHandoff('intact')
  const sibling = `${host}.bak`
  const draftText = `see ${formatNativeChatFileReference(host)} and ${formatNativeChatFileReference(sibling)} quoted "${host}"`
  updateNativeChatComposerDraft(
    recipient,
    {
      text: draftText,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'see ' },
              fileAtom(host),
              { type: 'text', text: ' and ' },
              fileAtom(sibling),
              { type: 'text', text: ` quoted "${host}"` }
            ]
          }
        ]
      }
    },
    'immediate'
  )

  moveNativeChatComposerDraft(source, recipient, { workspaceId: 'wt', executionHostId: 'local' })

  const repaired = readNativeChatComposerDraft(recipient)
  expect(repaired.text).toBe(
    `see ${formatNativeChatFileReference(text)} and ${formatNativeChatFileReference(sibling)} quoted "${host}"`
  )
  const atoms = JSON.stringify(repaired.document)
  expect(atoms).toContain(JSON.stringify(fileAtom(sibling)))
  expect(atoms).toContain(`"path":"${text}"`)
  expect(atoms).toContain(` quoted \\"${host}\\"`)
})

// With the returned reference removed, nothing is repaired: the longer sibling path stays untouched.
it('leaves a longer sibling path alone once the expired reference was removed', async () => {
  const { source, recipient, host } = await refuseTextBeforeHandoff('removed')
  const kept = `keep ${formatNativeChatFileReference(`${host}.bak`)}`
  updateNativeChatComposerDraft(recipient, { text: kept, document: undefined }, 'immediate')

  moveNativeChatComposerDraft(source, recipient, { workspaceId: 'wt', executionHostId: 'local' })

  expect(readNativeChatComposerDraft(recipient).text).toBe(kept)
})

// The move installs a pending caret for the moved typing; the repair write that follows carries it,
// shifted by the length change of the rewritten reference.
it('carries the handoff caret through the repair write', async () => {
  const { source, recipient, text, host } = await refuseTextBeforeHandoff('caret')
  updateNativeChatComposerDraft(source, { text: 'typed later' }, 'immediate')
  const position = (merged: { text: string }) => ({
    at: 'selection' as const,
    from: merged.text.length,
    to: merged.text.length,
    pending: true
  })

  moveNativeChatComposerDraft(source, recipient, undefined, position)

  const repaired = readNativeChatComposerDraft(recipient)
  expect(repaired.text).toContain(formatNativeChatFileReference(text))
  expect(repaired.text).not.toContain(host)
  const record = records.get(recipient)
  const carried = record && nativeChatDraftPositions.get(record)
  expect(carried).toMatchObject({ at: 'selection', pending: true })
  expect(carried && 'from' in carried ? carried.from : -1).toBe(repaired.text.length)
})

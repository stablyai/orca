// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'

// The browser token store and the host upload boundary are the only stand-ins: staging, the send
// lease, the hand-back and draft removal all run for real.
const released: string[] = []
const uploadedSources: string[] = []
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
      uploaded: paths.map((sourcePath) => ({
        sourcePath,
        path: `/host/agent-session-attachments/upload${nextUpload++}/file.png`
      })),
      failed: []
    }
  }
}))

const { reconcileNativeChatStagedDraft, stageNativeChatDraftFile } =
  await import('./native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput } = await import('./native-chat-staged-input')
const { readNativeChatComposerDraft } = await import('./native-chat-composer-draft-store')
const { deleteNativeChatComposerDraft } = await import('./native-chat-composer-draft-removal')
const { structuredAgentSessionDraftScopeKey } = await import('./native-chat-draft-scope')
const { handBackStructuredAgentSessionMessage } =
  await import('../session/structured/delivery/structured-agent-session-message-hand-back')
const { agentSessionAttachmentUploadIdOfPath } =
  await import('../../../../../shared/agent-session/agent-session-attachments')

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

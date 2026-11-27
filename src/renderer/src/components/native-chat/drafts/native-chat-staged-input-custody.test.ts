// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'

// The browser token store and the host upload boundary are the only stand-ins: staging, adoption,
// the send lease and its custody grant run for real. Each upload waits until the test lets it finish.
const uploadedSources: string[] = []
let finishUpload = (): void => {}
let uploadsWait = false
vi.mock('@/lib/files/drop/browser-attachment-files', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserAttachmentFiles>()),
  releaseBrowserAttachmentFiles: () => {}
}))
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
    if (uploadsWait) {
      await new Promise<void>((resolve) => (finishUpload = resolve))
    }
    return {
      uploaded: paths.map((sourcePath) => ({
        sourcePath,
        path: `/host/agent-session-attachments/${sourcePath.replace(/\W/g, '')}/file.png`
      })),
      failed: []
    }
  }
}))

const {
  adoptNativeChatStagedFile,
  nativeChatStagedFileDraftHolderScopes,
  reconcileNativeChatStagedDraft,
  stageNativeChatDraftFile,
  stagedNativeChatFiles
} = await import('./native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput, NativeChatStagedCustodyLostError } =
  await import('./native-chat-staged-input')
const { structuredAgentSessionDraftScopeKey } = await import('./native-chat-draft-scope')
const { readNativeChatHeldElsewhere, resetNativeChatHeldElsewhereForTests } =
  await import('../composer/controls/native-chat-held-elsewhere-notice')
const { nativeChatHeldElsewhereNow } =
  await import('../attachments/native-chat-browser-file-refusal')

// The live account: who holds the refused files now, read from the drafts (see D12-03).
const heldNow = (sessionId: string) => {
  const record = readNativeChatHeldElsewhere(sessionId)
  return record && nativeChatHeldElsewhereNow(record.references, sessionId).held
}

const SIBLING = '/host/agent-session-attachments/sibling/already.png'

beforeEach(() => {
  uploadedSources.length = 0
  uploadsWait = false
  resetNativeChatHeldElsewhereForTests()
})

/**
 * A Retry in chat `retry` naming one staged original and an already host-uploaded sibling, while the
 * old chat `old` can still adopt the original (a late refusal there returns it to its draft).
 */
function retryAgainst(name: string) {
  const retry = `${name}-retry`
  const old = `${name}-old`
  const scope = structuredAgentSessionDraftScopeKey(retry)
  const original = `orca-browser-file:${name}/shot.png`
  stageNativeChatDraftFile(scope, original)
  const input = {
    text: 'before [Image #1] and after [Image #2]',
    attachments: [{ path: original }, { path: SIBLING }]
  }
  const send = captureNativeChatStagedInput(scope, input)
  // The message left the composer: only the send's lease keeps the original now.
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  const adopt = () =>
    adoptNativeChatStagedFile(
      stagedNativeChatFiles(scope)!,
      original,
      structuredAgentSessionDraftScopeKey(old)
    )
  return { retry, old, scope, original, input, send, adopt }
}

// D11-03 / C15-03, before upload. The old chat adopted the original after this Retry captured it: no
// upload starts, the whole message is refused naming where the file is, and the old chat still holds
// it (its custody untouched) while the Retry's staging no longer does.
it('starts no upload for an original adopted before the upload', async () => {
  const { retry, old, original, input, send, adopt } = retryAgainst('pre-upload')
  adopt()

  const prepared = send.prepare(input, { sessionId: retry, runtimeEnvironmentId: 'env' })

  await expect(prepared).rejects.toBeInstanceOf(NativeChatStagedCustodyLostError)
  await expect(prepared).rejects.toMatchObject({ references: [original] })
  expect(uploadedSources).toEqual([])
  expect(nativeChatStagedFileDraftHolderScopes(original)).toEqual([
    structuredAgentSessionDraftScopeKey(old)
  ])
  // Intact in the old chat, so the refusal says where rather than calling it expired.
  expect(heldNow(retry)).toEqual({ count: 1, ownerSessionId: old })
})

// D11-03 / C15-03, during upload. The upload that started before the adoption finishes as the
// adopter's: its record moves with the original, and this Retry delivers nothing.
it('delivers no upload that finished after its original was adopted', async () => {
  const { retry, old, original, input, send, adopt } = retryAgainst('in-flight')
  uploadsWait = true
  const prepared = send.prepare(input, { sessionId: retry, runtimeEnvironmentId: 'env' })
  await vi.waitFor(() => expect(uploadedSources).toEqual([original]))

  adopt()
  finishUpload()

  await expect(prepared).rejects.toMatchObject({ references: [original] })
  const adopter = stagedNativeChatFiles(structuredAgentSessionDraftScopeKey(old))!
  expect([...adopter.uploaded.values()].map(({ source }) => source)).toEqual([original])
  expect(uploadedSources).toEqual([original])
})

// After preparation the grant still travels with the send, and the issue reads it: an adoption after
// mapping revokes it too, while the prepared message itself is unchanged.
it('hands the send a grant that an adoption after preparation revokes', async () => {
  const { retry, original, input, send, adopt } = retryAgainst('after-prepare')

  const prepared = await send.prepare(input, { sessionId: retry, runtimeEnvironmentId: 'env' })
  expect(prepared.custodyLost?.()).toEqual([])

  adopt()
  expect(prepared.custodyLost?.()).toEqual([original])
})

// The control: with custody intact, the original becomes its host upload in place and the sibling is
// untouched, so the exact ordered paths and the numbered text are what the send carries.
it('maps an owned original in place, keeping the sibling and the numbering', async () => {
  const { retry, input, send } = retryAgainst('healthy')

  const prepared = await send.prepare(input, { sessionId: retry, runtimeEnvironmentId: 'env' })

  expect(prepared.attachments?.map(({ path }) => path)).toEqual([
    '/host/agent-session-attachments/orcabrowserfilehealthyshotpng/file.png',
    SIBLING
  ])
  expect(prepared.text).toBe('before [Image #1] and after [Image #2]')
  expect(uploadedSources).toHaveLength(1)
})

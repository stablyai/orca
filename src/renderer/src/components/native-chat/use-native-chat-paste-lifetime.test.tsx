// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  structuredAgentSessionDraftScopeKey as scope
} from './native-chat-composer-draft-store'
import {
  type NativeChatComposerDraftOwner,
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { createChatDraftRemovalReceipt } from '@/store/slices/worktrees/teardown/chat-draft-removal-receipt'

const SESSION = 'paste-life-37190'

const WORKSPACE: NativeChatComposerDraftOwner = {
  workspaceId: 'repo-1::/workspace',
  executionHostId: 'local'
}
const owners: NativeChatAttachmentOwner[] = [
  { kind: 'local' },
  { kind: 'runtime-session', environmentId: 'paired', sessionId: SESSION, pairingRevision: 1 }
]

beforeEach(async () => {
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  setNativeChatComposerDraftOwnerResolver(() => WORKSPACE)
})
afterEach(async () => {
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
})

function fixture(owner: NativeChatAttachmentOwner) {
  const view = renderHook(
    ({ draftScope }) =>
      useNativeChatPasteLifetime({
        targetKey: draftScope,
        attachmentScopeKey: draftScope,
        beginPendingImageAttachment: () => 'upload',
        resolvePendingImageAttachment: (id, path, connectionId) => {
          settleNativeChatPendingAttachment(draftScope, id, path, connectionId)
        },
        dropPendingImageAttachment: (id) => {
          takeNativeChatPendingAttachment(draftScope, id)
        }
      }),
    { initialProps: { draftScope: scope(SESSION) } }
  )
  addNativeChatPendingAttachment(scope(SESSION), { id: 'upload', path: '', pending: true })
  view.result.current.track('upload', '', owner)
  return { view, lifetime: view.result.current }
}

it.each(owners)(
  'does not recreate a draft after its workspace is removed during a $kind upload',
  async (owner) => {
    const { view, lifetime } = fixture(owner)
    view.unmount()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn().mockResolvedValue({
            ok: true,
            result: {
              location: { kind: 'chat', sessionId: SESSION, worktreeId: WORKSPACE.workspaceId }
            }
          })
        }
      }
    })
    const receipt = createChatDraftRemovalReceipt(() => ({ unifiedTabsByWorktree: {} }))
    receipt.capture({ executionHostId: 'local' })({ workspaceId: WORKSPACE.workspaceId })
    await receipt.finish()
    lifetime.keepStoreUploadAfterUnmount('upload', {
      status: 'saved',
      tempPath: '/stored/image.png'
    })
    expect(nativeChatPendingAttachmentSnapshot(scope(SESSION))).toEqual([])
    expect(readNativeChatComposerDraft(scope(SESSION)).images).toEqual([])
  }
)

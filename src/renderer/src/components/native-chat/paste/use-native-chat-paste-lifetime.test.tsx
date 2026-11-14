// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'
import { clearNativeChatComposerDraftsForTests } from '../drafts/native-chat-draft-reset'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey as scope } from '../drafts/native-chat-draft-scope'
import { hydrateNativeChatComposerDrafts } from '../drafts/native-chat-composer-draft-load'
import { nativeChatComposerDraftWritesSettled } from '../drafts/native-chat-composer-draft-persistence'
import { setNativeChatComposerDraftOwnerResolver } from '../drafts/native-chat-composer-draft-memory'
import {
  type NativeChatComposerDraftOwner,
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../drafts/native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  dropNativeChatPendingAttachmentsOwnedBy,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment
} from '../attachments/chips/native-chat-pending-attachment-cache'
import type { NativeChatAttachmentOwner } from '../attachments/uploads/native-chat-attachment-owner'

const WORKSPACE: NativeChatComposerDraftOwner = {
  workspaceId: 'workspace-1',
  executionHostId: 'local'
}
const owners: NativeChatAttachmentOwner[] = [
  { kind: 'local' },
  { kind: 'runtime-session', environmentId: 'paired', sessionId: 'a', pairingRevision: 1 }
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
    { initialProps: { draftScope: scope('a') } }
  )
  addNativeChatPendingAttachment(scope('a'), { id: 'upload', path: '', pending: true })
  view.result.current.track('upload', '', owner)
  return { view, lifetime: view.result.current }
}

it.each(owners)(
  'does not recreate a draft after its workspace is removed during a $kind upload',
  (owner) => {
    const { view, lifetime } = fixture(owner)
    view.unmount()
    dropNativeChatPendingAttachmentsOwnedBy(WORKSPACE)
    lifetime.keepStoreUploadAfterUnmount('upload', {
      status: 'saved',
      tempPath: '/stored/image.png'
    })
    expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toEqual([])
    expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
  }
)

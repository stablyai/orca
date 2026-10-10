// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
  dropNativeChatPendingAttachmentsOwnedBy,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

const WORKSPACE: NativeChatComposerDraftOwner = {
  workspaceId: 'workspace-1',
  executionHostId: 'local'
}
const owners: NativeChatAttachmentOwner[] = [
  { kind: 'local' },
  {
    kind: 'ssh',
    connectionId: 'ssh-1',
    worktreePath: '/remote/worktree',
    expectedExecutionHostId: 'ssh:ssh-1',
    expectedSshTargetId: 'ssh-1',
    expectedSshConnectionGeneration: 1
  },
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

it.each(owners)('keeps a $kind upload when its composer closes', (owner) => {
  const { view, lifetime } = fixture(owner)
  view.unmount()
  expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toHaveLength(1)
  expect(
    lifetime.keepStoreUploadAfterUnmount('upload', {
      status: 'saved',
      tempPath: '/stored/image.png'
    })
  ).toBe(true)
  expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toEqual([])
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([
    {
      id: 'upload',
      path: '/stored/image.png',
      ...(owner.kind === 'ssh' ? { connectionId: 'ssh-1' } : {})
    }
  ])
  expect(readNativeChatComposerDraft(scope('b')).images).toEqual([])
})

it.each(owners)('keeps a $kind upload with its original scope after a target switch', (owner) => {
  const { view, lifetime } = fixture(owner)
  view.rerender({ draftScope: scope('b') })
  expect(
    lifetime.keepStoreUploadAfterUnmount('upload', {
      status: 'saved',
      tempPath: '/stored/image.png'
    })
  ).toBe(true)
  expect(readNativeChatComposerDraft(scope('a')).images).toHaveLength(1)
  expect(readNativeChatComposerDraft(scope('b')).images).toEqual([])
})

it.each(owners)('does not settle a removed $kind upload', (owner) => {
  const { view, lifetime } = fixture(owner)
  takeNativeChatPendingAttachment(scope('a'), 'upload')
  view.unmount()
  lifetime.keepStoreUploadAfterUnmount('upload', { status: 'saved', tempPath: '/stored/image.png' })
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
})

it.each(owners)('drops a failed $kind upload after teardown', (owner) => {
  const { view, lifetime } = fixture(owner)
  view.unmount()
  expect(lifetime.keepStoreUploadAfterUnmount('upload', { status: 'error' })).toBe(true)
  expect(nativeChatPendingAttachmentSnapshot(scope('a'))).toEqual([])
  expect(readNativeChatComposerDraft(scope('a')).images).toEqual([])
})

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

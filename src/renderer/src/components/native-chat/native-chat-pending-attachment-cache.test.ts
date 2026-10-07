import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  dropNativeChatPendingAttachmentsForTab,
  dropNativeChatPendingAttachmentsOwnedBy,
  nativeChatPendingAttachmentSnapshot,
  revealNativeChatPendingAttachment,
  settleNativeChatPendingAttachment,
  subscribeToNativeChatPendingAttachments,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import {
  clearNativeChatComposerDraftsForTests,
  deleteNativeChatComposerDraftsOwnedBy,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'

afterEach(() => {
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
})

const OWNER: NativeChatComposerDraftOwner = { workspaceId: 'wt-1', executionHostId: 'local' }

function addPending(scopeKey: string, id = scopeKey): void {
  addNativeChatPendingAttachment(scopeKey, { id, path: '', pending: true })
}

describe('the pane pending attachment cache', () => {
  it('keeps a chip with no composer subscribed, so one a prompt unmounted can still settle', () => {
    addNativeChatPendingAttachment('pane-a', {
      id: 'a1',
      path: '',
      pending: true,
      previewUrl: 'blob:preview'
    })

    // The composer keeps its own preview; the cache never holds one.
    expect(nativeChatPendingAttachmentSnapshot('pane-a')).toEqual([
      { id: 'a1', path: '', pending: true }
    ])
    expect(takeNativeChatPendingAttachment('pane-a', 'a1')).toEqual({
      id: 'a1',
      path: '',
      pending: true
    })
    expect(nativeChatPendingAttachmentSnapshot('pane-a')).toEqual([])
  })

  it('answers undefined for a chip the user already removed, so its file never attaches', () => {
    addNativeChatPendingAttachment('pane-b', { id: 'b1', path: '', pending: true })
    takeNativeChatPendingAttachment('pane-b', 'b1')

    expect(takeNativeChatPendingAttachment('pane-b', 'b1')).toBeUndefined()
  })

  it('shows a hidden chip and tells every subscriber, with a new snapshot only on change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToNativeChatPendingAttachments('pane-c', listener)
    addNativeChatPendingAttachment('pane-c', { id: 'c1', path: '', pending: true, hidden: true })
    const hidden = nativeChatPendingAttachmentSnapshot('pane-c')

    expect(nativeChatPendingAttachmentSnapshot('pane-c')).toBe(hidden)
    revealNativeChatPendingAttachment('pane-c', 'c1')

    expect(nativeChatPendingAttachmentSnapshot('pane-c')).toEqual([
      { id: 'c1', path: '', pending: true }
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('settles into a draft owned by the workspace it began in, after its chat stopped naming one', () => {
    const conversation = structuredAgentSessionDraftScopeKey('session-1')
    let open = true
    setNativeChatComposerDraftOwnerResolver((scopeKey) =>
      open && scopeKey === conversation ? OWNER : undefined
    )
    addPending(conversation)
    open = false

    expect(settleNativeChatPendingAttachment(conversation, conversation, '/store/a.png')).toBe(true)
    expect(readNativeChatComposerDraft(conversation).images).toHaveLength(1)
    deleteNativeChatComposerDraftsOwnedBy(OWNER)
    expect(readNativeChatComposerDraft(conversation).images).toEqual([])
  })

  it('drops the chips begun in a removed workspace on that host only', () => {
    const resolved = new Map<string, NativeChatComposerDraftOwner>([
      ['tab-1:leaf', OWNER],
      ['tab-2:leaf', { ...OWNER, executionHostId: 'ssh:box' }],
      ['tab-3:leaf', { ...OWNER, workspaceId: 'wt-2' }]
    ])
    setNativeChatComposerDraftOwnerResolver((scopeKey) => resolved.get(scopeKey))
    for (const scopeKey of [...resolved.keys(), 'tab-4:leaf']) {
      addPending(scopeKey)
    }

    dropNativeChatPendingAttachmentsOwnedBy(OWNER)

    expect(
      ['tab-1:leaf', 'tab-2:leaf', 'tab-3:leaf', 'tab-4:leaf'].map(
        (scopeKey) => nativeChatPendingAttachmentSnapshot(scopeKey).length
      )
    ).toEqual([0, 1, 1, 1])
    expect(settleNativeChatPendingAttachment('tab-1:leaf', 'tab-1:leaf', '/store/a.png')).toBe(
      false
    )
    expect(readNativeChatComposerDraft('tab-1:leaf').images).toEqual([])
  })

  it('drops the chips of every pane in a closed tab, never a conversation’s', () => {
    const conversation = structuredAgentSessionDraftScopeKey('session-1')
    for (const scopeKey of ['tab:1:leaf-a', 'tab:1:leaf-b', 'tab:10:leaf-a', conversation]) {
      addPending(scopeKey)
    }

    dropNativeChatPendingAttachmentsForTab('agent-session')
    dropNativeChatPendingAttachmentsForTab('tab:1')

    expect(
      ['tab:1:leaf-a', 'tab:1:leaf-b', 'tab:10:leaf-a', conversation].map(
        (scopeKey) => nativeChatPendingAttachmentSnapshot(scopeKey).length
      )
    ).toEqual([0, 0, 1, 1])
  })
})

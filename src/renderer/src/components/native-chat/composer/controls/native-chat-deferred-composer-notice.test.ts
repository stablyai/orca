// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'
import {
  closeNativeChatComposerNoticeRoute,
  deferNativeChatComposerNotice,
  hasDeferredNativeChatComposerNotice,
  openNativeChatComposerNoticeRoute,
  takeDeferredNativeChatComposerNotices
} from './native-chat-deferred-composer-notice'
import {
  addNativeChatPendingAttachment,
  moveNativeChatPendingAttachments,
  subscribeToNativeChatPendingAttachments,
  takeNativeChatPendingAttachment
} from '../../attachments/chips/native-chat-pending-attachment-cache'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsOwnedBy
} from '../../drafts/native-chat-composer-draft-removal'
import { moveNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-move'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'

// A failure reported before its draft moves is published where the draft went; once the draft is
// deleted for good, neither a waiting nor a late notice survives it.
it('routes a reported paste failure with its moving draft and retires it with a deleted one', () => {
  const moved = openNativeChatComposerNoticeRoute('notice-route-source')
  moveNativeChatPendingAttachments('notice-route-source', 'notice-route-destination')
  expect(closeNativeChatComposerNoticeRoute(moved)).toBe('notice-route-destination')

  const late = openNativeChatComposerNoticeRoute('notice-route-destination')
  deferNativeChatComposerNotice('notice-route-destination', 'Image paste failed.')
  deleteNativeChatComposerDraft('notice-route-destination')

  expect(closeNativeChatComposerNoticeRoute(late)).toBeNull()
  const shown: string[] = []
  takeDeferredNativeChatComposerNotices('notice-route-destination', ({ text }) =>
    shown.push(text)
  )()
  expect(shown).toEqual([])
})

const shownFor = (scope: string): string[] => {
  const shown: string[] = []
  takeDeferredNativeChatComposerNotices(scope, ({ text }) => shown.push(text))()
  return shown
}

// A closed conversation whose only input was a failed paste keeps no draft record, so removing its
// workspace must still find the waiting notice and any route still open by the owner they carry.
it('retires a notice and an open route with their workspace when no draft record names it', () => {
  const owner: NativeChatComposerDraftOwner = {
    workspaceId: 'notice-owner-workspace',
    executionHostId: 'local'
  }
  const open = openNativeChatComposerNoticeRoute('notice-owner-open', owner)
  deferNativeChatComposerNotice('notice-owner-waiting', 'Image paste failed.', undefined, owner)

  deleteNativeChatComposerDraftsOwnedBy(owner)

  expect(closeNativeChatComposerNoticeRoute(open)).toBeNull()
  expect(shownFor('notice-owner-waiting')).toEqual([])
})

// A route opened before its chip leaves the draft follows a move, or ends with a deletion, that the
// removal itself sets off synchronously.
it('keeps a route opened before the chip drop through a move or deletion during that drop', () => {
  for (const deleted of [false, true]) {
    const from = `notice-drop-source-${deleted}`
    const to = `notice-drop-destination-${deleted}`
    addNativeChatPendingAttachment(from, { id: `drop-${deleted}`, path: '', pending: true })
    const route = openNativeChatComposerNoticeRoute(from)
    const stop = subscribeToNativeChatPendingAttachments(from, () => {
      stop()
      if (deleted) {
        deleteNativeChatComposerDraft(from)
      } else {
        moveNativeChatPendingAttachments(from, to)
      }
    })
    takeNativeChatPendingAttachment(from, `drop-${deleted}`)
    expect(closeNativeChatComposerNoticeRoute(route)).toBe(deleted ? null : to)
  }
})

// An empty draft that carries only a waiting notice and an open report route moves under the owner
// the caller confirmed for the destination, so removing that workspace retires both.
it('moves a notice-only draft under the destination owner the move was given', () => {
  const before: NativeChatComposerDraftOwner = {
    workspaceId: 'notice-move-old',
    executionHostId: 'local'
  }
  const after: NativeChatComposerDraftOwner = {
    workspaceId: 'notice-move-new',
    executionHostId: 'local'
  }
  const route = openNativeChatComposerNoticeRoute('notice-move-source', before)
  deferNativeChatComposerNotice('notice-move-source', 'Image paste failed.', undefined, before)

  moveNativeChatComposerDraft('notice-move-source', 'notice-move-destination', after)
  deleteNativeChatComposerDraftsOwnedBy(after)

  expect(closeNativeChatComposerNoticeRoute(route)).toBeNull()
  expect(shownFor('notice-move-destination')).toEqual([])
})

// A failure still waiting for, or being reported to, a draft is that draft's feedback until shown.
it('reports a draft as holding feedback while a failure is waiting or being reported', () => {
  const scope = 'notice-presence'
  expect(hasDeferredNativeChatComposerNotice(scope)).toBe(false)
  const route = openNativeChatComposerNoticeRoute(scope)
  expect(hasDeferredNativeChatComposerNotice(scope)).toBe(true)
  closeNativeChatComposerNoticeRoute(route)
  deferNativeChatComposerNotice(scope, 'Image paste failed.')
  expect(hasDeferredNativeChatComposerNotice(scope)).toBe(true)
  expect(shownFor(scope)).toEqual(['Image paste failed.'])
  expect(hasDeferredNativeChatComposerNotice(scope)).toBe(false)
})

// Paired control: the draft holds stored input under another workspace (written before the move that
// brought the notice). Owner-only teardown retires the feedback by the notice's own confirmed owner and
// the stored input by the record's owner, so each workspace's cleanup takes only what it owns.
it('retires feedback by its confirmed owner even when the stored draft names another', () => {
  const scope = 'notice-conflicting-owner'
  const stored: NativeChatComposerDraftOwner = {
    workspaceId: 'notice-stored',
    executionHostId: 'local'
  }
  const confirmed: NativeChatComposerDraftOwner = {
    workspaceId: 'notice-confirmed',
    executionHostId: 'local'
  }
  appendToNativeChatComposerDraft(scope, { text: 'typed earlier' }, stored)
  const route = openNativeChatComposerNoticeRoute(scope, confirmed)
  deferNativeChatComposerNotice(scope, 'Image paste failed.', undefined, confirmed)

  deleteNativeChatComposerDraftsOwnedBy(stored)
  expect(readNativeChatComposerDraft(scope).text).toBe('')
  expect(hasDeferredNativeChatComposerNotice(scope)).toBe(true)

  deleteNativeChatComposerDraftsOwnedBy(confirmed)
  expect(closeNativeChatComposerNoticeRoute(route)).toBeNull()
  expect(shownFor(scope)).toEqual([])
})

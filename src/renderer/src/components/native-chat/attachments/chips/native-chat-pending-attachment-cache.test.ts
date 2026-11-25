// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachments,
  deferNativeChatPasteReference,
  flushNativeChatWaitingPasteReferences,
  moveNativeChatPendingAttachments,
  settleNativeChatPendingAttachment,
  settleNativeChatPendingAttachmentReferences,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import {
  holdNativeChatPendingImageSave,
  releaseNativeChatPendingImageSave,
  savingImageChips
} from './native-chat-pending-attachment-scopes'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'

// Data loss guard: a composer going unavailable must not drop an image main is still saving,
// nor the finished image queued behind it, so both reach the draft in paste order.
it('keeps a saving image and its queued successor when the composer goes unavailable', () => {
  const scope = 'pending-cache-invariant'
  addNativeChatPendingAttachment(scope, { id: 'first', path: '', pending: true })
  addNativeChatPendingAttachment(scope, { id: 'second', path: '', pending: true })
  holdNativeChatPendingImageSave('first')
  expect(settleNativeChatPendingAttachment(scope, 'second', '/tmp/second.png')).toBe(true)

  clearNativeChatPendingAttachments(scope, { keepSaving: true })

  expect(settleNativeChatPendingAttachment(scope, 'first', '/tmp/first.png')).toBe(true)
  releaseNativeChatPendingImageSave('first')
  expect(readNativeChatComposerDraft(scope).images.map(({ path }) => path)).toEqual([
    '/tmp/first.png',
    '/tmp/second.png'
  ])
})

// A composer that takes file references gets pasted images in paste order when saves finish out of order.
it('keeps a pasted image reference behind an earlier pasted image that is still saving', () => {
  const scope = 'pending-reference-order-invariant'
  addNativeChatPendingAttachment(scope, { id: 'early', path: '', pending: true })
  addNativeChatPendingAttachment(scope, { id: 'late', path: '', pending: true })
  holdNativeChatPendingImageSave('early')

  const late = [{ id: 'late', path: '/tmp/late.png' }]
  expect(
    deferNativeChatPasteReference(scope, 'late', {
      settle: () => settleNativeChatPendingAttachmentReferences(scope, late),
      cancel: () => {}
    })
  ).toBe(true)
  addNativeChatPendingAttachment(scope, { id: 'report', path: '', pending: true })
  expect(
    settleNativeChatPendingAttachmentReferences(scope, [{ id: 'report', path: '/tmp/report.txt' }])
  ).toBe(true)
  expect(readNativeChatComposerDraft(scope).text).toBe('@/tmp/report.txt')

  releaseNativeChatPendingImageSave('early')
  const early = [{ id: 'early', path: '/tmp/early.png' }]
  settleNativeChatPendingAttachmentReferences(scope, early)
  flushNativeChatWaitingPasteReferences(scope)

  expect(readNativeChatComposerDraft(scope).text).toBe(
    '@/tmp/report.txt @/tmp/early.png @/tmp/late.png'
  )
})

// A saving image follows its draft to the new scope (worktree hand-off, queued-edit hand-back) and
// survives that composer going unavailable; a deliberate discard there is final.
it('settles a saving image into the draft it moved to, and not after that draft is discarded', () => {
  const from = 'pending-move-source'
  const to = 'pending-move-destination'
  addNativeChatPendingAttachment(from, { id: 'moved', path: '', pending: true })
  addNativeChatPendingAttachment(from, { id: 'discarded', path: '', pending: true })
  holdNativeChatPendingImageSave('moved')
  holdNativeChatPendingImageSave('discarded')
  moveNativeChatPendingAttachments(from, to)

  clearNativeChatPendingAttachments(to, { keepSaving: true })
  expect(settleNativeChatPendingAttachment(from, 'moved', '/tmp/moved.png')).toBe(true)
  releaseNativeChatPendingImageSave('moved')
  clearNativeChatPendingAttachments(to)
  expect(settleNativeChatPendingAttachment(from, 'discarded', '/tmp/discarded.png')).toBe(false)
  releaseNativeChatPendingImageSave('discarded')

  expect(readNativeChatComposerDraft(to).images.map(({ path }) => path)).toEqual(['/tmp/moved.png'])
  expect(readNativeChatComposerDraft(from).images).toEqual([])
})

const pasted = (scope: string, id: string) => ({
  settle: () =>
    settleNativeChatPendingAttachmentReferences(scope, [{ id, path: `/tmp/${id}.png` }]),
  cancel: () => {}
})

// A later pasted reference waits behind one already waiting, not only behind an image still saving.
it('keeps a third pasted reference behind a waiting one after the first leaves the draft', () => {
  const scope = 'pending-three-paste-barrier'
  for (const id of ['A', 'B', 'C']) {
    addNativeChatPendingAttachment(scope, { id, path: '', pending: true })
  }
  holdNativeChatPendingImageSave('A')
  expect(deferNativeChatPasteReference(scope, 'B', pasted(scope, 'B'))).toBe(true)
  takeNativeChatPendingAttachment(scope, 'A')

  expect(deferNativeChatPasteReference(scope, 'C', pasted(scope, 'C'))).toBe(true)
  flushNativeChatWaitingPasteReferences(scope)

  expect(readNativeChatComposerDraft(scope).text).toBe('@/tmp/B.png @/tmp/C.png')
})

// Two composers of one draft: the replaced one settles A, the current one's B was waiting behind it.
// B drains in the same step and appends to the draft, never through an editor that may not hold A yet.
it('drains a waiting reference with its predecessor and appends it after that one', () => {
  const scope = 'pending-two-composer-order'
  addNativeChatPendingAttachment(scope, { id: 'A', path: '', pending: true })
  addNativeChatPendingAttachment(scope, { id: 'B', path: '', pending: true })
  holdNativeChatPendingImageSave('A')
  const staleEditorInsert = (paths: string[]) =>
    updateNativeChatComposerDraft(
      scope,
      { text: paths.map((path) => `@${path}`).join(' ') },
      'immediate'
    )
  expect(
    deferNativeChatPasteReference(scope, 'B', {
      settle: () =>
        settleNativeChatPendingAttachmentReferences(
          scope,
          [{ id: 'B', path: '/tmp/B.png' }],
          staleEditorInsert
        ),
      cancel: () => {}
    })
  ).toBe(true)

  settleNativeChatPendingAttachmentReferences(scope, [{ id: 'A', path: '/tmp/A.png' }])

  expect(readNativeChatComposerDraft(scope).text).toBe('@/tmp/A.png @/tmp/B.png')
})

// Removing or discarding a chip ends its save hold even if the save never returns; moving keeps it.
it('ends a save hold when its chip leaves every draft, keeps it across a move, never re-holds', () => {
  addNativeChatPendingAttachment('pending-hold-removed', { id: 'hung', path: '', pending: true })
  expect(holdNativeChatPendingImageSave('hung')).toBe(true)
  takeNativeChatPendingAttachment('pending-hold-removed', 'hung')
  expect(savingImageChips.has('hung')).toBe(false)
  expect(holdNativeChatPendingImageSave('hung')).toBe(false)

  addNativeChatPendingAttachment('pending-hold-from', { id: 'moving', path: '', pending: true })
  holdNativeChatPendingImageSave('moving')
  moveNativeChatPendingAttachments('pending-hold-from', 'pending-hold-to')
  expect(savingImageChips.has('moving')).toBe(true)
  clearNativeChatPendingAttachments('pending-hold-to')
  expect(savingImageChips.has('moving')).toBe(false)
})

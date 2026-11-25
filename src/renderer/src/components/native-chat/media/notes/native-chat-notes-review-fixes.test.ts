// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { nativeChatNotesImageName } from './native-chat-media-notes'
import {
  dismissNativeChatNotesNoticeFor,
  NATIVE_CHAT_NOTES_UNDO_MS,
  resetNativeChatNotesNoticesForTests,
  showNativeChatNotesNotice,
  useNativeChatNotesNotice
} from './native-chat-notes-notice'
import {
  nativeChatAnnotateReason,
  nativeChatNotesBlockedReason,
  nativeChatNotesKeptText
} from './native-chat-notes-reasons'
import {
  markNativeChatNotedImageEditing,
  nativeChatDraftHasEditingImage
} from './native-chat-chip-notes'
import { handleNativeChatMediaViewportKey } from './native-chat-media-viewport-keys'
import {
  useNativeChatMediaViewerFocus,
  type NativeChatMediaViewerFocusSession
} from './use-native-chat-media-viewer-focus'
import { appendToNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'

const SCOPE = 'agent-session:review'

beforeEach(() => {
  resetNativeChatNotesNoticesForTests()
  clearNativeChatComposerDraftsForTests()
})
afterEach(() => vi.useRealTimers())

it('names a copy of a marked copy by generation, never -notes-notes', () => {
  expect(nativeChatNotesImageName('dashboard.png', undefined)).toBe('dashboard-notes.png')
  expect(nativeChatNotesImageName('dashboard-notes.png', undefined)).toBe('dashboard-notes-2.png')
  expect(nativeChatNotesImageName('dashboard-notes-2.png', undefined)).toBe('dashboard-notes-3.png')
  expect(nativeChatNotesImageName('clip.mov', 1.5)).toBe('clip-1_50s-notes.png')
})

it('an Undo line lasts eight seconds, and an expired or replaced line undoes nothing', () => {
  vi.useFakeTimers()
  const undo = vi.fn()
  showNativeChatNotesNotice(SCOPE, { text: '2 notes removed', undo })
  const { result, rerender } = renderHook(() => useNativeChatNotesNotice(SCOPE))
  const stale = result.current?.action?.onClick
  expect(stale).toBeDefined()
  vi.advanceTimersByTime(NATIVE_CHAT_NOTES_UNDO_MS)
  rerender()
  expect(result.current).toBeNull()
  // A captured click from the expired line does nothing.
  stale?.()
  expect(undo).not.toHaveBeenCalled()
})

it('reopening a marked image ends the Undo of the line that announced it, and only that line', () => {
  const undo = vi.fn()
  showNativeChatNotesNotice(SCOPE, { text: '1 note added', undo, ids: ['img-1'] })
  dismissNativeChatNotesNoticeFor(SCOPE, 'img-2')
  const { result } = renderHook(() => useNativeChatNotesNotice(SCOPE))
  expect(result.current).not.toBeNull()
  dismissNativeChatNotesNoticeFor(SCOPE, 'img-1')
  const { result: after } = renderHook(() => useNativeChatNotesNotice(SCOPE))
  expect(after.current).toBeNull()
})

it('a reopened marked image counts as being edited only while it is in the draft', () => {
  appendToNativeChatComposerDraft(SCOPE, {
    text: '',
    images: [{ id: 'img-1', path: '/tmp/a.png' }]
  })
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(false)
  const done = markNativeChatNotedImageEditing(SCOPE, 'img-1')
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(true)
  // Replaced by its edited copy: the old id has left the draft.
  const other = markNativeChatNotedImageEditing(SCOPE, 'gone')
  done()
  expect(nativeChatDraftHasEditingImage(SCOPE)).toBe(false)
  other()
})

it('says why notes wait, by what the message box is doing', () => {
  const reasons = (['unavailable', 'editing', 'goal', 'command'] as const).map((blocked) => [
    nativeChatNotesBlockedReason(translate, blocked),
    nativeChatNotesKeptText(translate, blocked, 'a.png')
  ])
  expect(new Set(reasons.map(([send]) => send)).size).toBe(4)
  expect(new Set(reasons.map(([kept]) => kept)).size).toBe(4)
  expect(reasons[2][1]).toContain('goal')
})

it('makes images over 33 megapixels view-only, with a reason', () => {
  expect(nativeChatAnnotateReason(translate, true, { width: 6000, height: 5500 })).toBeNull()
  expect(nativeChatAnnotateReason(translate, true, { width: 7700, height: 4400 })).toContain(
    '33 megapixels'
  )
  expect(nativeChatAnnotateReason(translate, false, undefined)).not.toBeNull()
})

it('Shift+arrow pans a larger step than arrow', () => {
  const steps: number[] = []
  const viewport = document.createElement('div')
  viewport.addEventListener('wheel', (event) => steps.push(event.deltaX))
  const panZoom = {
    zoomBy: () => {},
    fit: () => {},
    isFitted: false,
    canZoomIn: true,
    canZoomOut: true
  }
  for (const shiftKey of [false, true]) {
    handleNativeChatMediaViewportKey(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields of the key event.
      {
        key: 'ArrowRight',
        shiftKey,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        target: viewport,
        currentTarget: viewport
      } as unknown as React.KeyboardEvent<HTMLDivElement>,
      { panZoom, annotating: false, onPlace: () => {} }
    )
  }
  expect(steps[1]).toBeGreaterThan(steps[0])
})

it('stepping to another image keeps the opener, and closing returns focus to it', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const state: NativeChatMediaViewerFocusSession = { opener: null, bodies: 0 }
  const session = { current: state }
  const event = (): Event => new Event('focus', { cancelable: true })
  // First image: records the opener.
  const first = renderHook(() => useNativeChatMediaViewerFocus(session, () => {}))
  first.result.current.onOpenAutoFocus(event())
  // Step: the next image mounts while focus sits on the page body, then the first unmounts.
  opener.blur()
  const second = renderHook(() => useNativeChatMediaViewerFocus(session, () => {}))
  second.result.current.onOpenAutoFocus(event())
  first.unmount()
  const stepped = event()
  first.result.current.onCloseAutoFocus(stepped)
  expect(stepped.defaultPrevented).toBe(true)
  expect(document.activeElement).not.toBe(opener)
  // Close.
  second.unmount()
  second.result.current.onCloseAutoFocus(event())
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

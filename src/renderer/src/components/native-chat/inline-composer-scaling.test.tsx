// @vitest-environment happy-dom
import { useLayoutEffect, useRef } from 'react'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  openNativeChatEditDraft,
  appendToNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  subscribeToNativeChatComposerDraftAppend
} from './native-chat-composer-draft-store'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  nativeChatPendingAttachmentSnapshot,
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  moveNativeChatPendingAttachments,
  settleNativeChatPendingAttachment,
  clearNativeChatPendingAttachments,
  useNativeChatPendingAttachments,
  subscribeToNativeChatPendingAttachments
} from './native-chat-pending-attachment-cache'
import {
  registerNativeChatComposerDestination,
  nativeChatComposerDestination,
  nativeChatComposerScopeDestination
} from './native-chat-composer-destination'
import {
  registerDictationComposerTarget,
  captureInsertionTarget
} from '../dictation/dictation-insertion-target'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { useNativeChatDraft } from './use-native-chat-draft'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
})

it.each([20, 200])(
  'isolates mounted draft, pending and composing append consumers across %i scopes',
  async (count) => {
    const scopes = [
      'queued-edit:own-host:target',
      ...Array.from({ length: count }, (_, i) => `queued-edit:other-host:${i}`)
    ]
    const own = scopes[0]
    const textRenders = new Map<string, number>()
    const pendingRenders = new Map<string, number>()
    const drafts = new Map<string, ReturnType<typeof useNativeChatDraft>>()
    let composing = false
    const isComposing = () => composing
    const upstream = scopes.map(() => ({ draft: vi.fn(), pending: vi.fn(), append: vi.fn() }))
    const releases = scopes.flatMap((scope, index) => {
      openNativeChatEditDraft(scope, { text: 'seed', images: [] })
      return [
        subscribeToNativeChatComposerDraft(scope, upstream[index].draft),
        subscribeToNativeChatPendingAttachments(scope, upstream[index].pending),
        subscribeToNativeChatComposerDraftAppend(scope, upstream[index].append)
      ]
    })
    function TextConsumer({ scope }: { scope: string }) {
      const draft = useNativeChatDraft(scope, isComposing)
      drafts.set(scope, draft)
      textRenders.set(scope, (textRenders.get(scope) ?? 0) + 1)
      return <span>{draft.draft}</span>
    }
    function PendingConsumer({ scope }: { scope: string }) {
      const chips = useNativeChatPendingAttachments(scope)
      pendingRenders.set(scope, (pendingRenders.get(scope) ?? 0) + 1)
      return <span>{chips.length}</span>
    }
    const view = render(
      <>
        {scopes.map((scope) => (
          <div key={scope}>
            <TextConsumer scope={scope} />
            <PendingConsumer scope={scope} />
          </div>
        ))}
      </>
    )
    await act(async () => {})
    textRenders.clear()
    pendingRenders.clear()
    act(() =>
      updateNativeChatComposerDraft(
        own,
        { images: [{ id: 'saved', path: '/saved.png' }] },
        'immediate'
      )
    )
    expect(textRenders.size).toBe(0)
    expect(pendingRenders.size).toBe(0)
    expect(upstream[0].draft).toHaveBeenCalledTimes(1)
    act(() => updateNativeChatComposerDraft(own, { text: 'own' }, 'immediate'))
    expect(textRenders.get(own)).toBe(1)
    expect(drafts.get(own)?.draft).toBe('own')
    expect(pendingRenders.size).toBe(0)
    act(() => addNativeChatPendingAttachment(own, { id: 'pending', path: '', pending: true }))
    expect(textRenders.get(own)).toBe(1)
    expect(pendingRenders.get(own)).toBe(1)
    composing = true
    act(() => appendToNativeChatComposerDraft(own, { text: 'returned' }))
    expect(drafts.get(own)?.draft).toBe('own')
    expect(upstream[0].append).toHaveBeenCalledTimes(1)
    act(() => drafts.get(own)!.flushDraftAppends())
    expect(drafts.get(own)?.draft).toBe('own\n\nreturned')
    expect(textRenders.size).toBe(1)
    expect(pendingRenders.size).toBe(1)
    expect(upstream[0].draft).toHaveBeenCalledTimes(3)
    expect(upstream[0].pending).toHaveBeenCalledTimes(1)
    for (const idle of upstream.slice(1)) {
      expect(idle.draft).not.toHaveBeenCalled()
      expect(idle.pending).not.toHaveBeenCalled()
      expect(idle.append).not.toHaveBeenCalled()
    }
    view.unmount()
    releases.forEach((release) => release())
    textRenders.clear()
    pendingRenders.clear()
    act(() => updateNativeChatComposerDraft(own, { text: 'after unmount' }, 'immediate'))
    act(() => addNativeChatPendingAttachment(own, { id: 'after', path: '', pending: true }))
    expect(textRenders.size + pendingRenders.size).toBe(0)
    expect(upstream[0].draft).toHaveBeenCalledTimes(3)
    expect(upstream[0].pending).toHaveBeenCalledTimes(1)
  }
)

it.each([20, 200])(
  'completes moved and cancelled chips without inspecting %i unrelated scopes',
  (count) => {
    let inspected = 0
    for (let i = 0; i < count; i++) {
      const scope = `other-${i}`
      addNativeChatPendingAttachment(scope, { id: `chip-${i}`, path: '', pending: true })
      Object.defineProperty(nativeChatPendingAttachmentSnapshot(scope)[0], 'id', {
        get() {
          inspected++
          return `chip-${i}`
        }
      })
    }
    addNativeChatPendingAttachment('source', { id: 'moved', path: '', pending: true })
    moveNativeChatPendingAttachments('source', 'destination')
    inspected = 0
    expect(settleNativeChatPendingAttachment('source', 'moved', '/moved.png')).toBe(true)
    expect(settleNativeChatPendingAttachment('source', 'moved', '/again.png')).toBe(false)
    addNativeChatPendingAttachment('source', { id: 'cancel', path: '', pending: true })
    clearNativeChatPendingAttachments('source')
    expect(settleNativeChatPendingAttachment('source', 'cancel', '/late.png')).toBe(false)
    expect(inspected).toBe(0)
  }
)

it.each([20, 200])(
  'bounds destination lookup by this pane, independent of %i other panes',
  (count) => {
    const releases: (() => void)[] = []
    const holder = document.createElement('div')
    document.body.append(holder)
    let reads = 0
    const handle: NativeChatComposerHandle = {
      focus: () => true,
      insertTypedText: () => true,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => true
    }
    const pane = document.createElement('div')
    const input = document.createElement('textarea')
    pane.append(input)
    holder.append(pane)
    const owned = {
      get current() {
        reads++
        return handle
      }
    }
    releases.push(
      registerNativeChatComposerDestination(input, owned, true, 'captured-scope'),
      registerDictationComposerTarget(pane, () => {})
    )
    for (let i = 0; i < count; i++) {
      const other = document.createElement('div')
      holder.append(other)
      releases.push(
        registerNativeChatComposerDestination(
          other,
          {
            get current(): NativeChatComposerHandle | null {
              throw new Error('unrelated handle read')
            }
          },
          true,
          `other-scope-${i}`
        ),
        registerDictationComposerTarget(other, () => {})
      )
    }
    input.focus()
    const contains = vi.spyOn(HTMLElement.prototype, 'contains')
    expect(nativeChatComposerDestination(pane, null)).toBe(handle)
    expect(captureInsertionTarget()?.kind).toBe('composer')
    expect(reads).toBe(1)
    expect(nativeChatComposerScopeDestination('captured-scope')).toBe(handle)
    expect(reads).toBe(2)
    expect(contains).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    expect(nativeChatComposerDestination(pane, null)).toBeNull()
    expect(nativeChatComposerScopeDestination('captured-scope')).toBeNull()
    holder.remove()
  }
)

it.each([10, 100])(
  'measures autocomplete only for its own scroll ancestors across %i menus and cleans up',
  (count) => {
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const view = render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} data-scroll={index}>
            <NativeChatMentionMenu
              mention={{ files: ['/a.ts'], loading: false, failed: false }}
              activeIndex={0}
              listboxId={`menu-${index}`}
              onChoose={() => {}}
            />
          </div>
        ))}
      </>
    )
    expect(measure).toHaveBeenCalledTimes(count)
    measure.mockClear()
    act(() => view.container.querySelector('[data-scroll="0"]')!.dispatchEvent(new Event('scroll')))
    expect(measure).toHaveBeenCalledTimes(1)
    measure.mockClear()
    act(() => window.dispatchEvent(new Event('resize')))
    expect(measure).toHaveBeenCalledTimes(count)
    measure.mockClear()
    view.unmount()
    window.dispatchEvent(new Event('resize'))
    expect(measure).not.toHaveBeenCalled()
  }
)

// The actual capture route runs before the input skip gate.
it.each([20, 200])(
  'routes a real key with constant local handle reads beside %i other panes',
  (count) => {
    const releases: (() => void)[] = []
    let localReads = 0
    const inserted = vi.fn(() => true)
    const handle: NativeChatComposerHandle = {
      focus: () => true,
      insertTypedText: inserted,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }
    function Pane() {
      const rootRef = useRef<HTMLDivElement>(null)
      const composerRef = useRef<NativeChatComposerHandle | null>(handle)
      const questionAnswerInputRef = useRef<HTMLInputElement>(null)
      const routing = useNativeChatRootInputRouting({
        tabId: 'scaling',
        rootRef,
        composerRef,
        questionAnswerInputRef,
        isVisible: false,
        isFocusedGroup: false,
        composerReady: false
      })
      useLayoutEffect(
        () =>
          registerNativeChatComposerDestination(
            rootRef.current!,
            {
              get current() {
                localReads++
                return handle
              }
            },
            true
          ),
        []
      )
      return (
        <div ref={rootRef} onKeyDownCapture={routing.onKeyDownCapture}>
          <textarea aria-label="owned" />
          <span>transcript</span>
        </div>
      )
    }
    for (let i = 0; i < count; i++) {
      const other = document.createElement('div')
      document.body.append(other)
      releases.push(
        registerNativeChatComposerDestination(
          other,
          {
            get current(): NativeChatComposerHandle | null {
              throw new Error('unrelated handle read')
            }
          },
          true,
          `other-scope-${i}`
        ),
        () => other.remove()
      )
    }
    const view = render(<Pane />)
    fireEvent.keyDown(view.getByLabelText('owned'), { key: 'a' })
    expect(inserted).not.toHaveBeenCalled()
    fireEvent.keyDown(view.getByText('transcript'), { key: 'b' })
    expect(inserted).toHaveBeenCalledExactlyOnceWith('b')
    expect(localReads).toBe(2)
    releases.forEach((release) => release())
  }
)

it.each([20, 200])(
  'hand-back visits only its own paste operation beside %i unrelated operations',
  (count) => {
    const ownId = '00000000-0000-4000-8000-000000000001'
    let unrelatedReads = 0
    const edit = createNativeChatQueuedEditDraft(
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'old' }] },
      'bottom'
    )
    for (let i = 0; i < count; i++) {
      nativeChatPastedTextOperations.set(`other-${i}`, {
        get scopeKey() {
          unrelatedReads++
          return `other-${i}`
        },
        text: 'other'
      })
    }
    const operation = { scopeKey: edit.scopeKey, text: 'own' }
    nativeChatPastedTextOperations.set(ownId, operation)
    updateNativeChatComposerDraft(
      edit.scopeKey,
      { text: nativeChatPastedTextToken(ownId), images: [] },
      'immediate'
    )
    handBackNativeChatQueuedEdit(edit)
    expect(operation.scopeKey).toBe('bottom')
    expect(unrelatedReads).toBe(0)
    discardNativeChatQueuedEdit(edit)
    nativeChatPastedTextOperations.clear()
  }
)

import { queuedEditPublicationKey } from '../../../../shared/queued-message-edit-publication'
it.each([10, 100])(
  'bounds a semantic publication lookup to three linear ID passes and one body at %i cards',
  (count) => {
    let ids = 0,
      bodies = 0
    const messages = Array.from({ length: count }, (_, index) => ({
      get messageId() {
        ids++
        return `message-${index}`
      },
      position: index,
      state: 'waiting' as const,
      get body() {
        bodies++
        if (index !== count - 1) {
          throw new Error('unrelated body read')
        }
        return {
          kind: 'message' as const,
          role: 'user' as const,
          blocks: [{ type: 'text' as const, text: 'target' }]
        }
      }
    }))
    const submissions = Array.from({ length: count }, (_, index) => ({
      clientMessageId: `submission-${index}`,
      get queuedMessageId() {
        ids++
        return `message-${index}`
      },
      payloadFingerprint: 'proof',
      fence: index,
      dispatchState: 'pending' as const,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }))
    queuedEditPublicationKey(
      { messages, cards: messages, submissions },
      'session',
      `message-${count - 1}`
    )
    expect(ids).toBe(3 * count)
    expect(bodies).toBe(1)
  }
)

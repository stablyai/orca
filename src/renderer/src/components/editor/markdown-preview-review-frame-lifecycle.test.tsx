// @vitest-environment happy-dom
import { act, StrictMode, type MutableRefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { VirtualMarkdownPreviewNavigation } from './VirtualMarkdownPreviewBody'
import {
  useMarkdownPreviewReviewActions,
  type MarkdownPreviewReviewActions
} from './use-markdown-preview-review-actions'
import {
  useMarkdownPreviewViewport,
  type MarkdownPreviewViewport
} from './use-markdown-preview-viewport'
import {
  cancelMarkdownPreviewEditorRevealFrames,
  requestMarkdownPreviewEditorRevealFrame
} from './markdown-preview-editor-reveal'

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function frameQueue() {
  let nextId = 0
  const pending = new Map<number, FrameRequestCallback>()
  const cancel = vi.fn((id: number) => pending.delete(id))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId
    pending.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  return {
    pending,
    cancel,
    flush: () => {
      for (const [id, callback] of Array.from(pending)) {
        pending.delete(id)
        callback(16)
      }
    }
  }
}

const cleanups = new Set<() => void>()

function mountSurface(
  strict = false,
  largeNavigationRef?: MutableRefObject<VirtualMarkdownPreviewNavigation | null>
) {
  const comment: DiffComment = {
    id: 'note',
    worktreeId: 'folder',
    filePath: 'readme.md',
    lineNumber: 1,
    body: 'review',
    createdAt: 1,
    side: 'modified'
  }
  const attention = vi.fn()
  const active = vi.fn()
  const fixture = {
    rootRef: ref<HTMLDivElement | null>(null),
    renderedContent: 'review text',
    markdownReviewNotes: [],
    reviewNotesCopyMountedRef: ref(false),
    setReviewNotesCopied: vi.fn(),
    reviewNotesCopiedResetTimerRef: ref<number | null>(null),
    setCopiedReviewNoteId: vi.fn(),
    copiedReviewNoteResetTimerRef: ref<number | null>(null),
    attentionReviewCommentTimeoutRef: ref<number | null>(null),
    pendingReviewActionFrameIdsRef: ref<number[]>([]),
    pendingReviewActionTimeoutIdsRef: ref<number[]>([]),
    reviewActionFrameGenerationRef: ref(0),
    setAttentionReviewCommentId: attention,
    setActiveReviewCommentId: active,
    markdownComments: [comment],
    activeReviewCommentId: null,
    bodyRef: ref<HTMLDivElement | null>(null),
    inputRef: ref<HTMLInputElement | null>(null),
    matchesRef: ref<Range[]>([]),
    searchInstanceRef: ref({}),
    lastAppliedInitialAnchorRef: ref<string | null>(null),
    pendingEditorRevealFrameIdsRef: ref<number[]>([]),
    isSearchOpen: false,
    setIsSearchOpen: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    matchCount: 0,
    setMatchCount: vi.fn(),
    searchRevision: 0,
    setSearchRevision: vi.fn(),
    activeMatchIndex: -1,
    setActiveMatchIndex: vi.fn(),
    keybindings: {},
    activeAnnotationBlockKeyRef: ref<string | null>(null),
    setActiveAnnotationBlockKey: vi.fn()
  }
  const usedFoundation: Pick<MarkdownPreviewFoundation, keyof typeof fixture> = fixture
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The checked fixture supplies every member read by the actual viewport and review-action hooks.
  const foundation = usedFoundation as unknown as MarkdownPreviewFoundation
  let actions: MarkdownPreviewReviewActions | undefined
  let viewport: MarkdownPreviewViewport | undefined
  function Surface() {
    viewport = useMarkdownPreviewViewport({
      foundation,
      scrollCacheKey: 'review-frame-test',
      initialAnchor: null,
      content: '',
      largePreview: largeNavigationRef !== undefined,
      largeNavigationRef,
      markdownAnnotationsEnabled: true
    })
    actions = useMarkdownPreviewReviewActions({ foundation, viewport })
    return (
      <div ref={viewport.setRootRef}>
        <div data-markdown-review-note-id="note" data-source-line="1" data-source-end-line="1" />
      </div>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      strict ? (
        <StrictMode>
          <Surface />
        </StrictMode>
      ) : (
        <Surface />
      )
    )
  )
  const cleanup = () => {
    act(() => root.unmount())
    host.remove()
    cleanups.delete(cleanup)
  }
  cleanups.add(cleanup)
  if (!actions || !viewport || !foundation.rootRef.current) {
    throw new Error('Missing mounted review surface')
  }
  const card = foundation.rootRef.current.querySelector<HTMLElement>(
    '[data-markdown-review-note-id]'
  )
  if (!card) {
    throw new Error('Missing rendered review card')
  }
  const scroll = vi.spyOn(card, 'scrollIntoView')
  const currentActions = actions
  const click = () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Annotation navigation reads only target from the React event.
    const event = { target: foundation.rootRef.current } as unknown as React.MouseEvent<HTMLElement>
    currentActions.handleAnnotatedMarkdownBlockClick({ startLine: 1, endLine: 1 }, event)
  }
  return {
    foundation,
    viewport,
    actions: currentActions,
    comment,
    attention,
    active,
    scroll,
    click,
    cleanup
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Markdown review frame lifetime', () => {
  it('keeps virtual source-line navigation immediate while retiring old review frames', () => {
    const frames = frameQueue()
    const order: string[] = []
    const sourceLine = vi.fn((line: number) => {
      order.push(`line:${line}`)
      return true
    })
    const navigationRef = ref<VirtualMarkdownPreviewNavigation | null>({
      anchor: vi.fn(() => true),
      sourceLine
    })
    const surface = mountSurface(false, navigationRef)
    const node = surface.foundation.rootRef.current
    if (!node) {
      throw new Error('Missing virtual review surface')
    }
    const queried = vi.spyOn(node, 'querySelectorAll')
    surface.active.mockImplementation((id: string) => order.push(`active:${id}`))
    surface.actions.scrollToReviewNote(surface.comment)
    expect(order).toEqual(['active:note', 'line:1'])
    expect(sourceLine.mock.calls).toEqual([[1]])
    expect(queried).not.toHaveBeenCalled()
    expect(surface.attention).not.toHaveBeenCalled()
    expect(frames.pending.size).toBe(0)

    surface.click()
    const callbacks = Array.from(frames.pending.values())
    expect(callbacks).toHaveLength(2)
    surface.viewport.setRootRef(null)
    for (const callback of callbacks) {
      callback(16)
    }
    expect(frames.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(surface.attention.mock.calls).toEqual([[null]])
    expect(surface.scroll).not.toHaveBeenCalled()
    expect(sourceLine).toHaveBeenCalledOnce()

    const successorSourceLine = vi.fn(() => true)
    navigationRef.current = { anchor: vi.fn(() => true), sourceLine: successorSourceLine }
    surface.viewport.setRootRef(node)
    surface.actions.scrollToReviewNote(surface.comment)
    for (const callback of callbacks) {
      callback(16)
    }
    expect(successorSourceLine.mock.calls).toEqual([[1]])
    expect(surface.active.mock.calls).toEqual([['note'], ['note'], ['note']])
    expect(surface.attention.mock.calls).toEqual([[null]])
    expect(surface.scroll).not.toHaveBeenCalled()
    expect(frames.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    successorSourceLine.mockReturnValue(false)
    surface.actions.scrollToReviewNote(surface.comment)
    navigationRef.current = null
    surface.actions.scrollToReviewNote(surface.comment)
    expect(surface.scroll.mock.calls).toEqual([
      [{ behavior: 'smooth', block: 'center' }],
      [{ behavior: 'smooth', block: 'center' }]
    ])
    expect(frames.pending.size).toBe(0)
  })

  it('leaves no suspended review callbacks after 64 actual surface unmounts', () => {
    const frames = frameQueue()
    for (let index = 0; index < 64; index += 1) {
      const surface = mountSurface()
      surface.click()
      surface.cleanup()
      expect(surface.foundation.rootRef.current).toBeNull()
      expect(surface.foundation.reviewNotesCopyMountedRef.current).toBe(false)
    }
    expect(frames.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'preserves both live frames and the exact 900 ms pulse in StrictMode=%s',
    (strict) => {
      const frames = frameQueue()
      const surface = mountSurface(strict)
      surface.click()
      expect(surface.active.mock.calls).toEqual([['note']])
      expect(surface.attention.mock.calls).toEqual([[null]])
      expect(surface.scroll).not.toHaveBeenCalled()
      expect(frames.pending.size).toBe(2)
      frames.flush()
      expect(surface.attention.mock.calls).toEqual([[null], ['note']])
      expect(surface.scroll.mock.calls).toEqual([
        [{ behavior: 'smooth', block: 'center', inline: 'nearest' }]
      ])
      expect(frames.pending.size).toBe(0)
      expect(surface.foundation.pendingReviewActionFrameIdsRef.current).toEqual([])
      vi.advanceTimersByTime(899)
      expect(surface.attention).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1)
      expect(surface.attention.mock.calls).toEqual([[null], ['note'], [null]])
      expect(surface.foundation.attentionReviewCommentTimeoutRef.current).toBeNull()
      surface.cleanup()
      expect(frames.cancel).not.toHaveBeenCalled()
    }
  )

  it('skips captured callbacks and late actions after unmount without starting another timer', () => {
    const frames = frameQueue()
    const surface = mountSurface()
    surface.click()
    const callbacks = Array.from(frames.pending.values())
    surface.cleanup()
    for (const callback of callbacks) {
      callback(16)
    }
    surface.click()
    expect(surface.attention.mock.calls).toEqual([[null]])
    expect(surface.active.mock.calls).toEqual([['note']])
    expect(surface.scroll).not.toHaveBeenCalled()
    expect(frames.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('preserves every live pulse with teardown before expiry=%s', (dispose) => {
    const frames = frameQueue()
    const surface = mountSurface()
    surface.click()
    surface.click()
    expect(frames.pending.size).toBe(4)
    frames.flush()
    expect(surface.attention.mock.calls).toEqual([[null], [null], ['note'], ['note']])
    expect(surface.scroll).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(899)
    expect(surface.attention).toHaveBeenCalledTimes(4)
    if (!dispose) {
      vi.advanceTimersByTime(1)
      expect(surface.attention.mock.calls).toEqual([
        [null],
        [null],
        ['note'],
        ['note'],
        [null],
        [null]
      ])
    }
    surface.cleanup()
    expect(vi.getTimerCount()).toBe(0)
    expect(surface.foundation.pendingReviewActionTimeoutIdsRef.current).toEqual([])
  })

  it('does not revive an old timer or clear a successor after same-node replacement', () => {
    const frames = frameQueue()
    const scheduled = vi.spyOn(window, 'setTimeout')
    const surface = mountSurface()
    const node = surface.foundation.rootRef.current
    surface.click()
    frames.flush()
    const timeout = scheduled.mock.calls.find((args) => args[1] === 900)?.[0]
    if (typeof timeout !== 'function') {
      throw new Error('Missing pulse timeout')
    }
    surface.viewport.setRootRef(null)
    surface.viewport.setRootRef(node)
    surface.click()
    frames.flush()
    const successor = surface.foundation.attentionReviewCommentTimeoutRef.current
    timeout()
    expect(surface.attention.mock.calls).toEqual([[null], ['note'], [null], ['note']])
    expect(surface.foundation.attentionReviewCommentTimeoutRef.current).toBe(successor)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps editor-navigation cancellation separate from live review frames', () => {
    const frames = frameQueue()
    const surface = mountSurface()
    const editorReveal = vi.fn()
    requestMarkdownPreviewEditorRevealFrame(
      surface.foundation.pendingEditorRevealFrameIdsRef,
      editorReveal
    )
    surface.click()
    expect(frames.pending.size).toBe(3)
    cancelMarkdownPreviewEditorRevealFrames(surface.foundation.pendingEditorRevealFrameIdsRef)
    expect(frames.pending.size).toBe(2)
    frames.flush()
    expect(editorReveal).not.toHaveBeenCalled()
    expect(surface.scroll).toHaveBeenCalledOnce()
    expect(surface.attention.mock.calls).toEqual([[null], ['note']])
  })

  it('keeps a successor attached to the same DOM node independent of old callbacks', () => {
    const frames = frameQueue()
    const surface = mountSurface()
    const node = surface.foundation.rootRef.current
    surface.click()
    const callbacks = Array.from(frames.pending.values())
    surface.viewport.setRootRef(null)
    surface.viewport.setRootRef(node)
    surface.click()
    for (const callback of callbacks) {
      callback(16)
    }
    expect(frames.pending.size).toBe(2)
    expect(surface.attention.mock.calls).toEqual([[null], [null]])
    expect(vi.getTimerCount()).toBe(0)
    frames.flush()
    expect(surface.attention.mock.calls).toEqual([[null], [null], ['note']])
    expect(surface.scroll).toHaveBeenCalledOnce()
  })

  it('does not cancel successor frames queued reentrantly by old frame cancellation', () => {
    const frames = frameQueue()
    const surface = mountSurface()
    const node = surface.foundation.rootRef.current
    surface.click()
    frames.cancel.mockImplementationOnce((id) => {
      frames.pending.delete(id)
      surface.viewport.setRootRef(node)
      surface.click()
      return true
    })
    surface.viewport.setRootRef(null)
    expect(frames.pending.size).toBe(2)
    expect(surface.foundation.pendingReviewActionFrameIdsRef.current).toHaveLength(2)
    frames.flush()
    expect(surface.scroll).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(['active', 'reset', 'pulse'])(
    'does not schedule new work after reentrant disposal in %s setter',
    (setter) => {
      const frames = frameQueue()
      const surface = mountSurface()
      if (setter === 'active') {
        surface.active.mockImplementationOnce(surface.cleanup)
      }
      if (setter === 'reset') {
        surface.attention.mockImplementationOnce(surface.cleanup)
      }
      if (setter === 'pulse') {
        surface.attention.mockImplementationOnce(() => {}).mockImplementationOnce(surface.cleanup)
      }
      surface.click()
      frames.flush()
      expect(frames.pending.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(surface.scroll).not.toHaveBeenCalled()
    }
  )

  it('drops completed frame references with a synchronous frame shim', () => {
    const frames = frameQueue()
    let nextId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(16)
      return ++nextId
    })
    const surface = mountSurface()
    surface.click()
    expect(surface.foundation.pendingReviewActionFrameIdsRef.current).toEqual([])
    expect(surface.scroll).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    surface.cleanup()
    expect(frames.cancel).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

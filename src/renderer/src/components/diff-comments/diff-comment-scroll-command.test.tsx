// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { consumeDiffCommentScrollCommand } from './diff-comment-scroll-command'
import {
  createScrollCommandFixture,
  flushScrollCommand,
  scrollNote
} from './diff-comment-scroll.test-fixture'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))
vi.mock('../right-sidebar/source-control/panel/worktree-scope', () => ({
  useSourceControlScope: () => null,
  sourceControlScopeRuntimeEnvironmentId: () => undefined
}))
afterEach(() => {
  useAppStore.getState().setScrollToDiffCommentId(null)
  vi.unstubAllGlobals()
})

it('cancels through the real owner and accepts the actual batched same-note opener without stale consumption', async () => {
  const fixture = createScrollCommandFixture()
  const surface = fixture.bindEditor()
  const hook = renderHook(() => fixture.useSurface(surface))
  try {
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    const canceled = fixture.combinedScrollRequestRef.current!
    expect(canceled.isCurrent()).toBe(true)
    await act(async () => {
      fixture.owner.input(0)
      surface.navigation.zoneMeasured(scrollNote.id)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    expect(fixture.combinedScrollRequestRef.current).toBeNull()
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    const old = fixture.combinedScrollRequestRef.current!
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      old.consume(() => {
        throw new Error('Old same-note callback consumed successor')
      })
      old.cancel()
      expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
      expect(fixture.combinedScrollRequestRef.current).not.toBe(old)
      await flushScrollCommand()
    })
    const current = fixture.combinedScrollRequestRef.current!
    await act(async () => {
      useAppStore.getState().setScrollToDiffCommentId('different')
      current.consume(() => {
        throw new Error('Old callback consumed different note')
      })
      current.cancel()
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe('different')
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      canceled.cancel()
      fixture.setReady(true)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    expect(fixture.owner.getScrollTop()).toBe(700)
  } finally {
    hook.unmount()
    fixture.dispose()
  }
})

it('preserves a command across native release but cancels it when input arrives during the binding gap', async () => {
  const fixture = createScrollCommandFixture()
  const hook = renderHook(({ surface }) => fixture.useSurface(surface), {
    initialProps: { surface: fixture.bindEditor() }
  })
  try {
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    const old = fixture.combinedScrollRequestRef.current!
    await act(async () => {
      fixture.owner.releaseItemNavigation(fixture.item)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
    expect(fixture.combinedScrollRequestRef.current).toBeNull()
    await act(async () => {
      fixture.owner.input(0)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    hook.rerender({ surface: fixture.bindEditor() })
    expect(fixture.combinedScrollRequestRef.current).toBeNull()
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    await act(async () => {
      fixture.owner.releaseItemNavigation(fixture.item)
      await flushScrollCommand()
    })
    hook.rerender({ surface: fixture.bindEditor() })
    expect(fixture.combinedScrollRequestRef.current).not.toBeNull()
    await act(async () => {
      old.consume(() => {
        throw new Error('Released binding consumed a new attempt')
      })
      fixture.setReady(true)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    expect(fixture.owner.getScrollTop()).toBe(700)
  } finally {
    hook.unmount()
    fixture.dispose()
  }
})

it('keeps a superseded single-file frame from consuming the newer same-note opening', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const fixture = createScrollCommandFixture()
  const surface = fixture.bindEditor(false)
  const hook = renderHook(() => fixture.useSurface(surface))
  try {
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    const oldFrame = frames.at(-1)!
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      oldFrame(0)
      expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
      await flushScrollCommand()
    })
    await act(async () => {
      frames.at(-1)!(0)
      await flushScrollCommand()
    })
    expect(surface.editor.getScrollTop()).toBe(580)
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
  } finally {
    hook.unmount()
    fixture.dispose()
  }
})

it('keeps note navigation through an overlay-only rebuild and releases actual zone lifetimes', async () => {
  const fixture = createScrollCommandFixture()
  let surface: ReturnType<typeof fixture.bindEditor> | null = fixture.bindEditor()
  const consumed = vi.fn(consumeDiffCommentScrollCommand)
  const hook = renderHook(
    ({
      current,
      label
    }: {
      current: ReturnType<typeof fixture.bindEditor> | null
      label: string
    }) => fixture.useDecoratorSurface(current, label, consumed),
    { initialProps: { current: surface, label: 'Add note' } }
  )
  const mountCard = async (): Promise<void> => {
    await act(async () => {
      await flushScrollCommand()
    })
    const zone = [...surface!.fake.zones.values()][0]
    expect(zone).toBeDefined()
    surface!.fake.domNode.append(zone.domNode)
    zone.domNode.style.padding = '0px'
    const card = zone.domNode.firstElementChild
    expect(card).toBeInstanceOf(HTMLElement)
    Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 152 })
    card!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 152)
    await act(async () => {
      surface!.layout()
      await flushScrollCommand()
    })
  }
  try {
    await mountCard()
    await act(async () => {
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
    hook.rerender({ current: surface, label: 'Add a note' })
    await act(async () => {
      fixture.setReady(true)
      await flushScrollCommand()
    })
    expect(fixture.owner.getScrollTop()).toBe(700)
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    expect(consumed.mock.calls).toEqual([['note']])

    await act(async () => {
      fixture.setReady(false)
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    hook.rerender({ current: null, label: 'Add a note' })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
    await act(async () => {
      fixture.owner.input(0)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    surface = fixture.bindEditor()
    hook.rerender({ current: surface, label: 'Add a note' })
    await mountCard()
    await act(async () => {
      fixture.setReady(true)
      await flushScrollCommand()
    })
    expect(consumed.mock.calls).toEqual([['note']])

    await act(async () => {
      fixture.setReady(false)
      hook.result.current.handleOpenComment(scrollNote)
      await flushScrollCommand()
    })
    hook.rerender({ current: null, label: 'Add a note' })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe('note')
    surface = fixture.bindEditor()
    hook.rerender({ current: surface, label: 'Add a note' })
    await mountCard()
    await act(async () => {
      fixture.setReady(true)
      await flushScrollCommand()
    })
    expect(useAppStore.getState().scrollToDiffCommentId).toBeNull()
    expect(consumed.mock.calls).toEqual([['note'], ['note']])
  } finally {
    hook.unmount()
    await act(flushScrollCommand)
    fixture.dispose()
  }
})

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, renderHook, within } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { useDiffCommentDraftZone } from './diff-comment-draft-zone'
import { useDiffCommentDecorator } from './useDiffCommentDecorator'
import { createFakeDiffCommentEditor } from './diff-comment-editor-test-fixture'
import { getCombinedDiffExtent } from '../editor/combined-diff-extent-dom'
import { installCombinedDiffSlice } from '../editor/combined-diff-slice'

vi.mock('monaco-editor', () => import('monaco-editor/esm/vs/editor/editor.api.js'))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        activeGroupIdByWorktree: {},
        clearDeliveredDiffComments: () => {}
      }),
    { getState: () => ({ keybindings: {} }) }
  )
}))

function fixture(deferred: boolean, height = 803) {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const flush = () =>
    act(() => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((cb) => cb(frameId))
    })
  const viewport = document.createElement('div')
  viewport.dataset.combinedDiffViewport = ''
  const extent = document.createElement('div')
  extent.dataset.combinedDiffExtent = ''
  const row = document.createElement('div')
  row.dataset.combinedDiffSectionRow = ''
  row.dataset.index = '1'
  const header = document.createElement('div')
  header.dataset.combinedDiffSectionHeader = ''
  const body = document.createElement('div')
  const host = document.createElement('div')
  const root = document.createElement('div')
  const original = createFakeDiffCommentEditor({ lineCount: 100 })
  const modified = createFakeDiffCommentEditor({ lineCount: 100 })
  root.append(original.domNode, modified.domNode)
  host.append(root)
  body.append(host)
  row.append(header, body)
  extent.append(row)
  viewport.append(extent)
  document.body.append(viewport)
  let top = 0
  let measured = 2049
  let nativeHeight = 2000
  let nativeCap = height - 30
  const writes: number[] = []
  Object.defineProperties(viewport, {
    clientHeight: { value: height },
    clientWidth: { value: 1000 },
    scrollHeight: { get: () => Number.parseFloat(extent.style.height) || 2739 },
    scrollTop: {
      get: () => top,
      set: (next: number) => {
        top = Math.max(0, Math.min(next, viewport.scrollHeight - height))
        writes.push(top)
        viewport.dispatchEvent(new Event('scroll'))
      }
    }
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 73, 1000, height)
  header.getBoundingClientRect = () => new DOMRect(0, 733 - top, 1000, 30)
  row.getBoundingClientRect = () => new DOMRect(0, 733 - top, 1000, measured)
  body.getBoundingClientRect = () => new DOMRect(0, 763 - top, 1000, measured - 30)
  Object.defineProperty(body, 'clientWidth', { value: 1000 })
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 2,
    getScrollElement: () => viewport,
    estimateSize: (i) => (i ? measured : 660),
    initialRect: { width: 1000, height },
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
    onChange: () => publish()
  })
  const owner = getCombinedDiffExtent(viewport)
  const publish = () => owner.publish(virtualizer.getMeasurements())
  const acknowledge = () => {
    measured = nativeHeight + 49
    body.style.height = `${nativeHeight + 19}px`
    virtualizer.resizeItem(1, measured)
    publish()
  }
  publish()
  const listeners = new Set<() => void>()
  const signal = (cb: () => void) => {
    listeners.add(cb)
    return { dispose: () => listeners.delete(cb) }
  }
  for (const fake of [original, modified]) {
    let scroll = 0
    Object.assign(fake.editor, {
      getContentHeight: () => nativeHeight,
      getBottomForLineNumber: (line: number) => line * 20,
      getWhitespaces: () =>
        [...fake.zones].map(([id, zone]) => ({
          id,
          afterLineNumber: zone.afterLineNumber,
          height: zone.heightInPx ?? 0
        })),
      getScrollTop: () => scroll,
      setScrollTop: (next: number) => {
        scroll = Math.max(0, Math.min(next, nativeHeight - nativeCap))
        for (const zone of fake.zones.values()) {
          zone.domNode.style.display =
            zone.afterLineNumber * 20 >= scroll + nativeCap ||
            zone.afterLineNumber * 20 + (zone.heightInPx ?? 0) < scroll
              ? 'none'
              : ''
        }
      },
      setScrollAnchorHandler: () => ({ dispose() {} }),
      onDidRequestReveal: () => ({ dispose() {} }),
      onDidChangeModel: () => ({ dispose() {} }),
      onDidContentSizeChange: signal,
      onDidChangeHiddenAreas: signal,
      onDidChangeViewZones: signal,
      onDidLayoutChange: signal
    })
    fake.domNode.getBoundingClientRect = () =>
      new DOMRect(0, 763 - top + Number.parseFloat(host.style.top || '0'), 500, nativeCap)
  }
  const changeZones = modified.editor.changeViewZones
  modified.editor.changeViewZones = (update) => {
    const previous = [...modified.zones.values()]
    changeZones(update)
    for (const zone of previous) {
      if (![...modified.zones.values()].includes(zone)) {
        zone.domNode.remove()
      }
    }
    for (const zone of modified.zones.values()) {
      const scroll = modified.editor.getScrollTop()
      zone.domNode.style.display =
        zone.afterLineNumber * 20 >= scroll + nativeCap ||
        zone.afterLineNumber * 20 + (zone.heightInPx ?? 0) < scroll
          ? 'none'
          : ''
      zone.domNode.style.padding = '0px'
      modified.domNode.append(zone.domNode)
      const bounds = () =>
        zone.domNode.style.display === 'none'
          ? new DOMRect()
          : new DOMRect(
              0,
              modified.domNode.getBoundingClientRect().top +
                zone.afterLineNumber * 20 -
                modified.editor.getScrollTop(),
              500,
              zone.domNode.querySelector('textarea')
                ? 152.5 +
                    Math.min(
                      180,
                      (zone.domNode.querySelector('textarea')!.value.split('\n').length - 1) * 20
                    )
                : 88
            )
      zone.domNode.getBoundingClientRect = bounds
      zone.onDomNodeTop?.(bounds().top)
    }
    nativeHeight =
      2000 + [...modified.zones.values()].reduce((sum, zone) => sum + (zone.heightInPx ?? 0), 0)
    if (!deferred) {
      acknowledge()
    }
    listeners.forEach((cb) => cb())
  }
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLTextAreaElement
  ) {
    return 60 + (this.value.split('\n').length - 1) * 20
  })
  const bounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const zone = this.closest('.orca-diff-comment-inline')
    if (zone && this !== zone) {
      const rect = zone.getBoundingClientRect()
      if (!rect.height) {
        return new DOMRect()
      }
      if (this instanceof HTMLTextAreaElement) {
        return new DOMRect(0, rect.top + 38, 500, rect.height - 92.5)
      }
      if (this.closest('.orca-diff-comment-popover-footer')) {
        return new DOMRect(0, rect.bottom - 42, 500, 32)
      }
      return new DOMRect(0, rect.top, 500, rect.height)
    }
    return bounds.call(this)
  })
  const focus = HTMLElement.prototype.focus
  const unowned: number[] = []
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    if (this instanceof HTMLTextAreaElement && !options?.preventScroll) {
      unowned.push(top)
      viewport.scrollTop = 448.5
      publish()
    }
    focus.call(this, options)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every diff member reached by the slice; code editors come from the existing comment fixture.
  const diff = {
    getContainerDomNode: () => root,
    getOriginalEditor: () => original.editor,
    getModifiedEditor: () => modified.editor,
    layout: ({ height }: { height: number }) => {
      nativeCap = height
    }
  } as unknown as editor.IStandaloneDiffEditor
  const dispose = installCombinedDiffSlice(diff, body, (height) => {
    nativeHeight = height
    if (!deferred) {
      acknowledge()
    }
  })
  const visible = () => {
    const zone = [...modified.zones.values()][0]!
    const rect = zone.domNode.getBoundingClientRect()
    expect(rect.top).toBeGreaterThanOrEqual(103)
    expect(rect.bottom).toBeLessThanOrEqual(73 + height)
    expect(unowned).toEqual([])
  }
  return { modified, viewport, owner, flush, acknowledge, dispose, visible, writes }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

for (const deferred of [false, true]) {
  it(`reveals a bottom following-file draft after geometry, without focus scrolling (deferred=${deferred})`, () => {
    const f = fixture(deferred)
    const hook = renderHook(() =>
      useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
    )
    act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
    act(f.acknowledge)
    f.flush()
    f.flush()
    f.visible()
    expect(f.writes).toHaveLength(1)
    const textarea = f.modified.domNode.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    const landed = f.viewport.scrollTop
    fireEvent.change(textarea, { target: { value: 'qa' } })
    f.flush()
    expect(f.viewport.scrollTop).toBe(landed)
    fireEvent.keyDown(textarea, { key: 'Escape' })
    f.flush()
    expect(f.modified.zones.size).toBe(0)
    f.dispose()
  })
}

it('reveals editing an existing note through the same owner', () => {
  const f = fixture(true)
  const comments = [
    {
      id: 'note',
      filePath: 'clip-b',
      worktreeId: '',
      lineNumber: 5,
      body: 'saved note',
      createdAt: 1,
      side: 'modified' as const
    }
  ]
  renderHook(
    ({ target }: { target: string | null }) =>
      useDiffCommentDecorator({
        editor: f.modified.editor,
        filePath: 'clip-b',
        worktreeId: '',
        comments,
        onDeleteComment: () => {},
        onUpdateComment: async () => true,
        pendingScrollCommentId: target
      }),
    { initialProps: { target: null } }
  )
  fireEvent.click(within(f.modified.domNode).getByRole('button', { name: 'Edit note' }))
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  expect(document.activeElement).toBe(f.modified.domNode.querySelector('textarea'))
  fireEvent.keyDown(f.modified.domNode.querySelector('textarea')!, { key: 'Escape' })
  f.dispose()
})

it('reveals an explicit thread request and does not recreate canceled navigation on refresh', () => {
  const f = fixture(true)
  const note = {
    id: 'note',
    filePath: 'clip-b',
    worktreeId: '',
    lineNumber: 5,
    body: 'saved note',
    createdAt: 1
  }
  const consumed = vi.fn()
  const hook = renderHook(
    ({ comments, target }) =>
      useDiffCommentDecorator({
        editor: f.modified.editor,
        filePath: 'clip-b',
        worktreeId: '',
        comments,
        onDeleteComment: () => {},
        pendingScrollCommentId: target,
        onPendingScrollConsumed: consumed
      }),
    { initialProps: { comments: [note], target: 'note' as string | null } }
  )
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  expect(consumed).toHaveBeenCalledOnce()
  hook.rerender({ comments: [note], target: null })
  act(() => f.owner.navigate(0))
  hook.rerender({ comments: [note], target: 'note' })
  f.viewport.dispatchEvent(new Event('wheel'))
  const before = f.writes.length
  hook.rerender({ comments: [{ ...note }], target: 'note' })
  act(f.acknowledge)
  f.flush()
  f.flush()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes).toHaveLength(before)
  expect(consumed).toHaveBeenCalledTimes(2)
  hook.rerender({ comments: [note], target: null })
  hook.rerender({ comments: [note], target: 'note' })
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  expect(consumed).toHaveBeenCalledTimes(3)
  f.dispose()
})

it('cancels pending visibility on real input and never revives it while carrying draft text', () => {
  const f = fixture(true)
  const hook = renderHook(
    ({ identity }) =>
      useDiffCommentDraftZone({
        editor: f.modified.editor,
        monacoModelIdentity: identity,
        onCreateComment: async () => false
      }),
    { initialProps: { identity: 'old' } }
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  const textarea = f.modified.domNode.querySelector('textarea')!
  fireEvent.change(textarea, { target: { value: 'keep my text' } })
  f.viewport.dispatchEvent(new Event('wheel'))
  const before = f.writes.length
  hook.rerender({ identity: 'new' })
  f.flush()
  act(f.acknowledge)
  f.flush()
  f.flush()
  expect(f.modified.domNode.querySelector('textarea')?.value).toBe('keep my text')
  expect(f.writes).toHaveLength(before)
  expect(document.activeElement).not.toBe(f.modified.domNode.querySelector('textarea'))
  f.dispose()
})

it('retires an unmounted or canceled composer before late geometry can navigate or focus', () => {
  const f = fixture(true)
  const hook = renderHook(() =>
    useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  act(() => hook.result.current.disposeDraftZone())
  hook.unmount()
  act(f.acknowledge)
  f.flush()
  f.flush()
  expect(f.writes).toEqual([])
  expect(f.modified.zones.size).toBe(0)
  f.dispose()
})

it('uses newly published EOF extent, while a composer already on screen does not move', () => {
  const f = fixture(true)
  const hook = renderHook(() =>
    useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
  )
  act(() => f.owner.navigate(600))
  f.writes.length = 0
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 244 }))
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  expect(f.writes).toEqual([])
  act(() =>
    hook.result.current.onAddCommentClickRef.current({ lineNumber: 100, startLine: 95, top: 0 })
  )
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  expect(f.writes).toHaveLength(1)
  expect(f.owner.trailingSlack).toBe(0)
  f.dispose()
})

it('lets newer explicit navigation supersede an unmeasured composer', () => {
  const f = fixture(true)
  const hook = renderHook(() =>
    useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  act(() => f.owner.navigate(400))
  const before = f.writes.length
  act(f.acknowledge)
  f.flush()
  f.flush()
  expect(f.viewport.scrollTop).toBe(400)
  expect(f.writes).toHaveLength(before)
  expect(document.activeElement).not.toBe(f.modified.domNode.querySelector('textarea'))
  f.dispose()
})

it('accepts fresh typing growth after landing without retaining a focus-follow obligation', () => {
  const f = fixture(true)
  const hook = renderHook(() =>
    useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  fireEvent.change(f.modified.domNode.querySelector('textarea')!, {
    target: { value: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine' }
  })
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  f.viewport.dispatchEvent(new Event('wheel'))
  act(() => f.owner.navigate(0))
  const before = f.writes.length
  act(f.acknowledge)
  f.flush()
  f.flush()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes).toHaveLength(before)
  f.dispose()
})

it('shows the focused control of an oversized card, then makes its footer reachable by Tab', () => {
  const f = fixture(true, 120)
  const hook = renderHook(() =>
    useDiffCommentDraftZone({ editor: f.modified.editor, onCreateComment: async () => true })
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  act(f.acknowledge)
  f.flush()
  f.flush()
  const textarea = f.modified.domNode.querySelector('textarea')!
  expect(textarea.getBoundingClientRect().top).toBeGreaterThanOrEqual(103)
  expect(textarea.getBoundingClientRect().bottom).toBeLessThanOrEqual(193)
  fireEvent.keyDown(textarea, { key: 'Tab' })
  f.flush()
  f.flush()
  const cancel = within(f.modified.domNode).getByRole('button', { name: 'Cancel' })
  expect(document.activeElement).toBe(cancel)
  expect(cancel.getBoundingClientRect().top).toBeGreaterThanOrEqual(103)
  expect(cancel.getBoundingClientRect().bottom).toBeLessThanOrEqual(193)
  f.dispose()
})

it('recovers a failed submission after replacement without reviving reveal or autofocus', async () => {
  const f = fixture(true)
  let finish: (result: boolean) => void = () => {}
  const hook = renderHook(
    ({ identity }) =>
      useDiffCommentDraftZone({
        editor: f.modified.editor,
        monacoModelIdentity: identity,
        onCreateComment: () =>
          new Promise<boolean>((resolve) => {
            finish = resolve
          })
      }),
    { initialProps: { identity: 'old' } }
  )
  act(() => hook.result.current.onAddCommentClickRef.current({ lineNumber: 5, top: 844 }))
  act(f.acknowledge)
  f.flush()
  f.flush()
  f.visible()
  fireEvent.change(f.modified.domNode.querySelector('textarea')!, {
    target: { value: 'retain this failed note' }
  })
  fireEvent.click(within(f.modified.domNode).getByRole('button', { name: 'Add note' }))
  hook.rerender({ identity: 'replacement' })
  f.viewport.dispatchEvent(new Event('wheel'))
  act(() => f.owner.navigate(0))
  const before = f.writes.length
  await act(async () => {
    finish(false)
  })
  act(f.acknowledge)
  f.flush()
  f.flush()
  const restored = f.modified.domNode.querySelector('textarea')!
  expect(restored.value).toBe('retain this failed note')
  expect(document.activeElement).not.toBe(restored)
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes).toHaveLength(before)
  f.dispose()
})

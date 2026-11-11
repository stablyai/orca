// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCombinedDiffOwnerMemory } from '../remember-view/use-combined-diff-owner-memory'
import {
  claimCombinedDiffView,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  forgetCombinedDiffViewsForWorktrees
} from '../remember-view/combined-diff-view-cache'
import { createNativeBindingFixture, nativeCommit } from './combined-diff-native.test-fixture'
import { resizeDiffCommentZone } from '../../../diff-comments/diff-comment-view-zone-entry'
import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import { observeCombinedDiffRowChrome } from './combined-diff-row-chrome'
import { revealCombinedCommentZone } from './combined-diff-editor-geometry'

vi.mock('@/lib/editor/monaco/monaco-setup', async () => ({
  monaco: await import('monaco-editor/esm/vs/editor/editor.api.js')
}))

function rect(top: number, height: number): DOMRect {
  return new DOMRect(0, top, 400, height)
}

describe('combined native reveal integration', () => {
  it.each([3087, 88])(
    'restores a fresh owner through pending native alignment with cached height %i',
    async (height) => {
      const previous = await createNativeBindingFixture(0, { pending: false })
      let view: ReturnType<typeof previous.owner.getViewMemory>
      try {
        previous.owner.input(1600)
        view = previous.owner.getViewMemory()
        expect(view).toEqual({ scrollAnchor: { key: 'target', offset: 1000 }, scrollTop: 1600 })
      } finally {
        previous.dispose()
      }
      const fixture = await createNativeBindingFixture(0, { pending: true, height, view })
      try {
        expect(fixture.original.getScrollTop()).toBe(0)
        expect(fixture.modified.getScrollTop()).toBe(0)
        expect(fixture.owner.getViewMemory()).toEqual(view)
        const published: number[] = []
        const unsubscribe = fixture.owner.subscribeScroll(() =>
          published.push(fixture.owner.getScrollTop())
        )
        fixture.completeAlignment()
        await nativeCommit()
        unsubscribe()
        expect(fixture.owner.getScrollTop()).toBe(1600)
        expect(
          28 + fixture.modified.getTopForPosition(53, 1) - fixture.modified.getScrollTop()
        ).toBe(16)
        expect(fixture.owner.getViewMemory()).toEqual(view)
        expect(published).not.toContain(600)
      } finally {
        fixture.dispose()
      }
    }
  )

  it.each(['input', 'clamped input', 'reveal', 'remove', 'final'] as const)(
    'retires an imported restore when %s replaces its pending target',
    async (action) => {
      const fixture = await createNativeBindingFixture(0, {
        pending: true,
        view: { scrollAnchor: { key: 'target', offset: 1000 }, scrollTop: 1600 }
      })
      try {
        if (action === 'input' || action === 'clamped input') {
          fixture.owner.input(action === 'input' ? -500 : 0)
        } else if (action === 'reveal') {
          fixture.reveal('gotoLine', 100)
        } else if (action === 'remove') {
          fixture.owner.setItems(fixture.restoreItems().filter(({ key }) => key !== 'target'))
        } else {
          fixture.owner.setItems(
            fixture
              .restoreItems(88)
              .map((item) =>
                item.key === 'target'
                  ? { ...item, generation: 'final', bodyKind: 'final' as const }
                  : item
              )
          )
          fixture.owner.measure(fixture.owner.getItem('target')!, 88)
        }
        await nativeCommit()
        fixture.completeAlignment()
        await nativeCommit()
        expect(fixture.owner.getViewMemory().scrollAnchor).not.toEqual({
          key: 'target',
          offset: 1000
        })
        if (action === 'reveal') {
          const projection =
            28 + fixture.modified.getTopForPosition(100, 1) - fixture.modified.getScrollTop()
          expect(projection).toBeGreaterThanOrEqual(28)
          expect(projection).toBeLessThanOrEqual(481)
        } else if (action === 'remove') {
          expect(fixture.owner.getViewMemory().scrollAnchor?.key).toBe('tail')
          fixture.owner.setItems(fixture.restoreItems())
          await nativeCommit()
          expect(fixture.owner.getViewMemory().scrollAnchor?.key).toBe('tail')
        }
      } finally {
        fixture.dispose()
      }
    }
  )

  it('saves the original pending import when view-memory cleanup precedes native alignment', async () => {
    const view = { scrollAnchor: { key: 'target', offset: 1000 }, scrollTop: 1600 }
    const fixture = await createNativeBindingFixture(0, { pending: true, height: 88 })
    const lease = claimCombinedDiffView('pending-native-restore', 'pending-native-restore')
    const restore = {
      invalidateViewStateCache: () => {},
      latestDomScrollAnchorRef: { current: view.scrollAnchor },
      memoryLeaseRef: { current: lease },
      scrollAnchorRef: { current: view.scrollAnchor },
      scrollOffsetRef: { current: view.scrollTop }
    }
    const hook = renderHook(() =>
      useCombinedDiffOwnerMemory({
        owner: fixture.owner,
        restore,
        entrySignature: 'pending-native-restore',
        viewStateKey: 'pending-native-restore'
      })
    )
    try {
      await act(nativeCommit)
      expect(fixture.owner.getScrollTop()).toBe(600)
      hook.unmount()
      const saved = readCombinedDiffViewMemory('pending-native-restore')
      expect(saved?.scrollAnchor).toEqual({ key: 'target', offset: 1000 })
      expect(saved?.scrollTop).toBe(1600)
    } finally {
      hook.unmount()
      fixture.dispose()
      releaseCombinedDiffView(lease)
      forgetCombinedDiffViewsForWorktrees(['pending-native-restore'])
    }
  })

  it('opens the measured own-zone controls once while DOM translation lags native geometry', async () => {
    const fixture = await createNativeBindingFixture(7)
    const { owner, modified, zone } = fixture
    const parent = document.createElement('div')
    parent.style.width = '100px'
    const node = document.createElement('div')
    node.style.display = 'none'
    node.style.padding = '0px'
    const card = document.createElement('div')
    const textarea = document.createElement('textarea')
    const footer = document.createElement('div')
    card.append(textarea, footer)
    node.append(card)
    parent.append(node)
    owner.scene.append(parent)
    let cardHeight = 152
    // The node and children retain the old translation independently of native scroll.
    node.getBoundingClientRect = () => rect(700, cardHeight)
    card.getBoundingClientRect = () => rect(700, cardHeight)
    textarea.getBoundingClientRect = () => rect(712, 92)
    footer.getBoundingClientRect = () => rect(832, 23)
    Object.defineProperty(textarea, 'offsetHeight', {
      get: () => (node.style.display === 'none' ? 0 : 92)
    })
    Object.defineProperty(footer, 'offsetHeight', {
      get: () => (node.style.display === 'none' ? 0 : 23)
    })
    const delegate = { afterLineNumber: 70, heightInPx: 152, domNode: node }
    let focused = 0
    const published: number[] = []
    let unsubscribe = (): void => {}
    try {
      owner.input(1000)
      cardHeight = 163
      unsubscribe = owner.subscribeScroll(() => published.push(owner.getScrollTop()))
      expect(resizeDiffCommentZone(modified, { zoneId: zone.id, domNode: node, delegate })).toBe(
        true
      )
      zone.height = delegate.heightInPx
      expect(zone.height).toBe(163)
      expect(
        revealCombinedCommentZone({
          editor: modified,
          id: zone.id,
          node,
          controls: () => [textarea, footer],
          focus: () => {
            focused++
            textarea.focus({ preventScroll: true })
          }
        })
      ).toBe(true)
      await nativeCommit()
      expect(owner.getScrollTop()).toBe(1103)
      expect(28 + zone.top + 12 - modified.getScrollTop()).toBe(330)
      expect(28 + zone.top + 155 - modified.getScrollTop()).toBe(473)
      expect(new Set(published)).toEqual(new Set([1103]))
      expect(focused).toBe(1)
      expect(node.getBoundingClientRect().top).toBe(700)
      expect(node.style.display).toBe('none')
      expect(parent.style.width).toBe('100px')
      owner.invalidate(fixture.item)
      await nativeCommit()
      expect(new Set(published)).toEqual(new Set([1103]))
      expect(owner.getScrollTop()).toBe(1103)
      expect(focused).toBe(1)
    } finally {
      unsubscribe()
      fixture.dispose()
    }
  })

  it('fits controls before acknowledging an opening in a partially visible row', async () => {
    const fixture = await createNativeBindingFixture()
    const { owner, modified, zone } = fixture
    const parent = document.createElement('div')
    const node = document.createElement('div')
    const card = document.createElement('div')
    const textarea = document.createElement('textarea')
    const footer = document.createElement('div')
    node.style.display = 'none'
    node.style.padding = '0px'
    card.append(textarea, footer)
    node.append(card)
    parent.append(node)
    owner.scene.append(parent)
    node.getBoundingClientRect = () => rect(700, 163)
    card.getBoundingClientRect = () => rect(700, 163)
    textarea.getBoundingClientRect = () => rect(712, 92)
    footer.getBoundingClientRect = () => rect(832, 23)
    Object.defineProperty(textarea, 'offsetHeight', { value: 92 })
    Object.defineProperty(footer, 'offsetHeight', { value: 23 })
    let focused = 0
    try {
      owner.setItems([
        { key: 'prefix', generation: '1', height: 400, collapsed: false, index: 0 },
        { key: 'long.ts', generation: '1', height: 3000, collapsed: false, index: 1 }
      ])
      await nativeCommit()
      zone.top = 40
      const delegate = { afterLineNumber: 2, heightInPx: 152, domNode: node }
      expect(resizeDiffCommentZone(modified, { zoneId: zone.id, domNode: node, delegate })).toBe(
        true
      )
      zone.height = delegate.heightInPx
      expect(
        revealCombinedCommentZone({
          editor: modified,
          id: zone.id,
          node,
          controls: () => [textarea, footer],
          focus: () => {
            focused++
          }
        })
      ).toBe(true)
      await nativeCommit()
      const row = owner.getItemLayout('long.ts')!
      const bodyTop = row.renderedStart - owner.getLayout().renderedTop + 28
      expect(bodyTop + zone.top + 12 - modified.getScrollTop()).toBeGreaterThanOrEqual(28)
      expect(bodyTop + zone.top + 155 - modified.getScrollTop()).toBeLessThanOrEqual(500)
      expect(focused).toBe(1)
    } finally {
      fixture.dispose()
    }
  })

  it('reuses the committed reading marker across input and preserves its edited line', async () => {
    const fixture = await createNativeBindingFixture()
    const model = fixture.modified.getModel()!
    const create = vi.spyOn(model, 'createTrackedRange')
    try {
      fixture.owner.input(1000)
      expect(create).not.toHaveBeenCalled()
      fixture.owner.input(19)
      fixture.owner.input(19)
      expect(create).not.toHaveBeenCalled()
      model.pushEditOperations(
        null,
        [
          {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            text: 'inserted\n'
          }
        ],
        () => null
      )
      fixture.owner.invalidate(fixture.item)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1057)
    } finally {
      create.mockRestore()
      fixture.dispose()
    }
  })

  it('re-resolves a native hidden-area remap at equal height without rebuilding extents', async () => {
    const fixture = await createNativeBindingFixture()
    const rebuild = vi.spyOn(CombinedDiffExtentIndex.prototype, 'rebuildSuffix')
    try {
      fixture.owner.input(1000)
      rebuild.mockClear()
      fixture.changeHiddenMapping(38)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1038)
      expect(28 + fixture.modified.getTopForPosition(53, 1) - fixture.modified.getScrollTop()).toBe(
        16
      )
      expect(fixture.owner.getLayout().logicalHeight).toBe(3000)
      expect(rebuild).not.toHaveBeenCalled()
    } finally {
      rebuild.mockRestore()
      fixture.dispose()
    }
  })

  it('lets an explicit reveal supersede input queued while the viewport was detached', async () => {
    const fixture = await createNativeBindingFixture()
    const host = document.createElement('div')
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } })
    const detach = fixture.owner.mount(host)
    detach()
    try {
      fixture.owner.input(1000)
      fixture.reveal('keyboard', 79)
      const unmount = fixture.owner.mount(host)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1067)
      unmount()
    } finally {
      fixture.dispose()
    }
  })

  it('updates an existing native row when its conflict chrome changes height', async () => {
    const fixture = await createNativeBindingFixture()
    const row = fixture.item.node!
    fixture.item.chrome.header!.setAttribute('data-combined-diff-section-header', '')
    fixture.item.chrome.body?.setAttribute('data-combined-diff-body', '')
    const conflict = document.createElement('div')
    conflict.setAttribute('data-combined-diff-conflict', '')
    let height = 24
    Object.defineProperty(conflict, 'offsetHeight', { get: () => height })
    row.insertBefore(conflict, fixture.item.chrome.body)
    let resized = (): void => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    const stop = observeCombinedDiffRowChrome(fixture.item, row)
    try {
      await nativeCommit()
      fixture.owner.input(1000 - fixture.owner.getScrollTop())
      height = 48
      resized()
      await nativeCommit()
      expect(fixture.owner.getLayout().logicalHeight).toBe(3048)
      expect(fixture.owner.getScrollTop()).toBe(1000)
      expect(76 + fixture.modified.getTopForPosition(53, 1) - fixture.modified.getScrollTop()).toBe(
        64
      )
      stop()
      height = 72
      resized()
      await nativeCommit()
      expect(fixture.owner.getLayout().logicalHeight).toBe(3048)
    } finally {
      stop()
      vi.unstubAllGlobals()
      fixture.dispose()
    }
  })

  it('ignores restore/model-change, preserves a visible mouse line and excludes the horizontal scrollbar for keyboard reveal', async () => {
    const fixture = await createNativeBindingFixture()
    try {
      fixture.owner.input(1051)
      fixture.reveal('mouse', 79, true)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1051)
      fixture.owner.input(-51)
      fixture.reveal('restoreState', 145)
      fixture.reveal('modelChange', 145)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1000)
      fixture.reveal('mouse', 55)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1000)
      fixture.setHorizontal()
      await nativeCommit()
      fixture.reveal('keyboard', 79)
      await nativeCommit()
      expect(fixture.owner.getScrollTop()).toBe(1087)
      expect(28 + 1482 - fixture.modified.getScrollTop()).toBe(423)
      expect(28 + 1501 - fixture.modified.getScrollTop()).toBe(442)
    } finally {
      fixture.dispose()
    }
  })
})

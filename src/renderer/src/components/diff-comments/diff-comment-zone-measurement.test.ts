// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { CombinedDiffCommentGeometry } from '../editor/combined-diff/scroll-viewport/combined-diff-comment-geometry'
import { CombinedDiffViewportOwner } from '../editor/combined-diff/scroll-viewport/combined-diff-viewport-owner'
import { registerCombinedEditorGeometry } from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import {
  registerDiffCommentZoneMeasurement,
  requestDiffCommentZoneMeasurement
} from './diff-comment-zone-measurement'

function createMeasurementFixture(count: number) {
  const owner = new CombinedDiffViewportOwner()
  owner.setItems([{ key: 'file', generation: '1', height: 3000, collapsed: false, index: 0 }])
  const item = owner.getItem('file')!
  const parent = document.createElement('div')
  parent.style.width = '100px'
  document.body.append(parent)
  const events: string[] = []
  const queries: string[] = []
  const ready: string[] = []
  const entries = Array.from({ length: count }, (_, index) => {
    const node = document.createElement('div')
    node.style.display = 'none'
    node.style.padding = '0px'
    const card = document.createElement('div')
    node.append(card)
    parent.append(node)
    const entry = {
      zoneId: `zone-${index}`,
      domNode: node,
      delegate: { afterLineNumber: index + 1, heightInPx: 152, domNode: node },
      lifetime: new AbortController(),
      height: index === 0 ? 163 : 208,
      currentCalls: 0,
      onMeasured: (): void => {}
    }
    card.getBoundingClientRect = () => {
      events.push(`read-${index}:${parent.style.width}:${node.style.display}`)
      return new DOMRect(0, 0, 400, entry.height)
    }
    return entry
  })
  const zones = new Map(entries.map((entry) => [entry.zoneId, entry]))
  let layout: (() => void) | undefined
  let content: (() => void) | undefined
  let contentWidth = 760
  const raw = {
    getViewZoneBounds: (id: string) => {
      queries.push(id)
      return zones.has(id) ? { id, top: 20, height: 152, hidden: false } : null
    },
    getLayoutInfo: () => ({ contentWidth }),
    getScrollWidth: () => contentWidth,
    onDidLayoutChange: (listener: () => void) => {
      layout = listener
      return {
        dispose: () => {
          layout = undefined
        }
      }
    },
    onDidContentSizeChange: (listener: () => void) => {
      content = listener
      return {
        dispose: () => {
          content = undefined
        }
      }
    },
    changeViewZones: (update: (accessor: editor.IViewZoneChangeAccessor) => void) => {
      events.push('commit')
      update({
        layoutZone: (id) => {
          events.push(`write-${id}`)
        },
        addZone: () => '',
        removeZone: () => {}
      })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the pane methods consumed by comment measurement and geometry.
  const pane = raw as unknown as editor.ICodeEditor
  const geometry = new CombinedDiffCommentGeometry({
    item,
    detached: false,
    usableHeight: () => 500,
    fitRange: () => null,
    usableInterval: () => null,
    project: () => null,
    resolveTop: () => null
  })
  const unbind = registerCombinedEditorGeometry(pane, {
    item,
    identity: 'binding',
    onUnbind: new Set(),
    registerZone: (id, node, controls) => geometry.register(pane, id, node, controls),
    measureZone: (id, node, measure) => geometry.measureZone(pane, id, node, measure) ?? false,
    zonePoint: (id, node, controls) => geometry.zonePoint(pane, id, node, controls)
  })
  for (const entry of entries) {
    registerDiffCommentZoneMeasurement(
      pane,
      entry,
      entry.lifetime.signal,
      () => {
        entry.currentCalls++
        return !entry.lifetime.signal.aborted
      },
      () => {
        ready.push(entry.zoneId)
        events.push(`ready-${entry.zoneId}`)
        entry.onMeasured()
      }
    )
  }
  return {
    pane,
    parent,
    entries,
    events,
    queries,
    ready,
    layout: () => layout?.(),
    setWidth: (width: number) => {
      contentWidth = width
      content?.()
    },
    subscribed: () => layout !== undefined || content !== undefined,
    reset: () => {
      events.length = 0
      queries.length = 0
      ready.length = 0
      for (const entry of entries) {
        entry.currentCalls = 0
      }
    },
    dispose: () => {
      for (const entry of entries) {
        entry.lifetime.abort()
      }
      unbind()
      parent.remove()
      owner.dispose()
    }
  }
}

describe('pane comment reservation measurement', () => {
  it('prepares all zones at the changed native width, reads before one reservation batch, and restores styles', () => {
    const fixture = createMeasurementFixture(2)
    const widthWrites = vi.spyOn(fixture.parent.style, 'width', 'set')
    try {
      fixture.layout()
      expect(fixture.events).toEqual([
        'read-0:760px:block',
        'read-1:760px:block',
        'commit',
        'write-zone-0',
        'write-zone-1',
        'ready-zone-0',
        'ready-zone-1'
      ])
      expect(fixture.entries.map((entry) => entry.delegate.heightInPx)).toEqual([163, 208])
      expect(fixture.entries.map((entry) => entry.domNode.style.display)).toEqual(['none', 'none'])
      expect(widthWrites.mock.calls).toEqual([['760px'], ['100px']])
      expect(fixture.parent.style.width).toBe('100px')
      fixture.reset()
      widthWrites.mockClear()
      fixture.setWidth(520)
      expect(fixture.events).toEqual([
        'read-0:520px:block',
        'read-1:520px:block',
        'ready-zone-0',
        'ready-zone-1'
      ])
      expect(widthWrites.mock.calls).toEqual([['520px'], ['100px']])
    } finally {
      widthWrites.mockRestore()
      fixture.dispose()
    }
  })

  it.each([20, 200])(
    'reads only the dirty card among %i zones at unchanged width',
    async (count) => {
      const fixture = createMeasurementFixture(count)
      const widthWrites = vi.spyOn(fixture.parent.style, 'width', 'set')
      const styleReads = vi.spyOn(window, 'getComputedStyle')
      try {
        fixture.layout()
        // Native render has already applied the same actual width to the zone container.
        fixture.parent.style.width = '760px'
        fixture.reset()
        widthWrites.mockClear()
        styleReads.mockClear()
        const target = fixture.entries[10]
        target.height = 240
        requestDiffCommentZoneMeasurement(fixture.pane, target)
        requestDiffCommentZoneMeasurement(fixture.pane, target)
        await Promise.resolve()
        expect(fixture.events).toEqual([
          'read-10:760px:block',
          'commit',
          'write-zone-10',
          'ready-zone-10'
        ])
        expect(fixture.ready).toEqual(['zone-10'])
        expect(styleReads).toHaveBeenCalledExactlyOnceWith(target.domNode)
        expect(widthWrites).not.toHaveBeenCalled()
        expect(new Set(fixture.queries)).toEqual(new Set(['zone-10']))
        expect(
          fixture.entries
            .filter((entry) => entry !== target)
            .every((entry) => entry.currentCalls === 0)
        ).toBe(true)
        expect(target.delegate.heightInPx).toBe(240)
        expect(target.domNode.style.display).toBe('none')

        // Offscreen native render may still carry the prior width: prepare and restore only once.
        fixture.parent.style.width = '100px'
        fixture.reset()
        widthWrites.mockClear()
        styleReads.mockClear()
        requestDiffCommentZoneMeasurement(fixture.pane, target)
        await Promise.resolve()
        expect(fixture.events).toEqual(['read-10:760px:block', 'ready-zone-10'])
        expect(styleReads).toHaveBeenCalledExactlyOnceWith(target.domNode)
        expect(widthWrites.mock.calls).toEqual([['760px'], ['100px']])

        fixture.reset()
        widthWrites.mockClear()
        styleReads.mockClear()
        requestDiffCommentZoneMeasurement(fixture.pane, target)
        target.lifetime.abort()
        await Promise.resolve()
        expect(fixture.events).toEqual([])
        expect(fixture.queries).toEqual([])
        expect(styleReads).not.toHaveBeenCalled()
        expect(widthWrites).not.toHaveBeenCalled()
        expect(fixture.subscribed()).toBe(true)
      } finally {
        styleReads.mockRestore()
        widthWrites.mockRestore()
        fixture.dispose()
      }
    }
  )

  it('retains requests made during a flush and cancels all old-pane work at retirement', async () => {
    const fixture = createMeasurementFixture(2)
    try {
      fixture.layout()
      fixture.reset()
      const [first, second] = fixture.entries
      first.onMeasured = () => requestDiffCommentZoneMeasurement(fixture.pane, second)
      requestDiffCommentZoneMeasurement(fixture.pane, first)
      await Promise.resolve()
      expect(fixture.ready).toEqual(['zone-0'])
      await Promise.resolve()
      expect(fixture.ready).toEqual(['zone-0', 'zone-1'])
      fixture.reset()
      first.onMeasured = () => {
        fixture.setWidth(520)
        second.lifetime.abort()
      }
      requestDiffCommentZoneMeasurement(fixture.pane, first)
      await Promise.resolve()
      expect(fixture.events).toEqual(['read-0:760px:block', 'ready-zone-0'])
      first.onMeasured = () => {}
      await Promise.resolve()
      expect(fixture.events).toEqual([
        'read-0:760px:block',
        'ready-zone-0',
        'read-0:520px:block',
        'ready-zone-0'
      ])
      fixture.reset()
      requestDiffCommentZoneMeasurement(fixture.pane, first)
      first.lifetime.abort()
      expect(fixture.subscribed()).toBe(false)
      // A reused physical pane gets independent membership before the old queued callback drains.
      const replacement = { ...first, zoneId: 'replacement', lifetime: new AbortController() }
      registerDiffCommentZoneMeasurement(
        fixture.pane,
        replacement,
        replacement.lifetime.signal,
        () => !replacement.lifetime.signal.aborted,
        () => fixture.ready.push('replacement')
      )
      try {
        await Promise.resolve()
        expect(fixture.events).toEqual([])
        expect(fixture.ready).toEqual([])
      } finally {
        replacement.lifetime.abort()
      }
    } finally {
      fixture.dispose()
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  arrangePaneCanvasBounds,
  collectPaneCanvasGroupIds,
  createPaneCanvasWorkspaceState,
  reconcilePaneCanvasWorkspaceState,
  resolvePaneCanvasDrop,
  resolvePaneCanvasOverlaps
} from './pane-canvas-layout-state'
import {
  paneCanvasStorageKey,
  readPaneCanvasWorkspaceState,
  writePaneCanvasWorkspaceState
} from './pane-canvas-layout-storage'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  }
}

describe('pane canvas layout state', () => {
  it('collects groups in split-tree order', () => {
    expect(
      collectPaneCanvasGroupIds({
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'left' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'top-right' },
          second: { type: 'leaf', groupId: 'bottom-right' }
        }
      })
    ).toEqual(['left', 'top-right', 'bottom-right'])
  })

  it('packs panes into deterministic rows', () => {
    const arranged = arrangePaneCanvasBounds(['a', 'b', 'c'], 1200)
    expect(arranged.a).toMatchObject({ x: 8, y: 8 })
    expect(arranged.b.x).toBeGreaterThan(arranged.a.x)
    expect(arranged.c).toMatchObject({ x: 8, y: 376 })
  })

  it('arranges positions without changing pane dimensions', () => {
    const arranged = arrangePaneCanvasBounds(['a', 'b'], 1200, {
      a: { x: 900, y: 700, width: 420, height: 280 },
      b: { x: 20, y: 900, width: 640, height: 520 }
    })
    expect(arranged.a).toEqual({ x: 8, y: 8, width: 420, height: 280 })
    expect(arranged.b).toEqual({ x: 436, y: 8, width: 640, height: 520 })
  })

  it('repairs existing overlaps deterministically', () => {
    const shared = { x: 8, y: 8, width: 560, height: 360 }
    const resolved = resolvePaneCanvasOverlaps(['first', 'second'], {
      first: shared,
      second: shared
    })

    expect(resolved.first).toEqual(shared)
    expect(resolved.second).not.toEqual(shared)
    expect(
      resolved.second.x >= shared.x + shared.width + 8 ||
        resolved.second.y >= shared.y + shared.height + 8
    ).toBe(true)
  })

  it('can retain bounded dormant bounds for global canvases', () => {
    const original = createPaneCanvasWorkspaceState(['active', 'dormant'])
    original.boundsByTerminalTabId.dormant = {
      x: 744,
      y: 456,
      width: 640,
      height: 480
    }

    const whileStopped = reconcilePaneCanvasWorkspaceState(original, ['active'], undefined, {
      preserveMissingBounds: true
    })
    expect(whileStopped.boundsByTerminalTabId.dormant).toEqual({
      x: 744,
      y: 456,
      width: 640,
      height: 480
    })

    const restarted = reconcilePaneCanvasWorkspaceState(
      whileStopped,
      ['active', 'dormant'],
      undefined,
      { preserveMissingBounds: true }
    )
    expect(restarted.boundsByTerminalTabId.dormant).toEqual({
      x: 744,
      y: 456,
      width: 640,
      height: 480
    })
  })

  it('still prunes missing bounds for ordinary project canvases', () => {
    const original = createPaneCanvasWorkspaceState(['active', 'closed'])
    const reconciled = reconcilePaneCanvasWorkspaceState(original, ['active'])
    expect(reconciled.boundsByTerminalTabId).not.toHaveProperty('closed')
  })

  it('repairs an overlapping saved layout even when the legacy toggle was off', () => {
    const storage = memoryStorage()
    const shared = { x: 8, y: 8, width: 560, height: 360 }
    storage.setItem(
      paneCanvasStorageKey('legacy-overlap'),
      JSON.stringify({
        version: 2,
        mode: 'canvas',
        preferences: { snap: true, preventOverlap: false },
        boundsByTerminalTabId: { first: shared, second: shared }
      })
    )

    const restored = readPaneCanvasWorkspaceState(storage, 'legacy-overlap', ['first', 'second'])
    expect(restored).not.toHaveProperty('preferences')
    expect(restored.boundsByTerminalTabId.first).toEqual(shared)
    expect(restored.boundsByTerminalTabId.second).not.toEqual(shared)
  })

  it('round-trips mode and bounds per owner', () => {
    const storage = memoryStorage()
    const state = createPaneCanvasWorkspaceState(['a'])
    state.mode = 'canvas'
    state.boundsByTerminalTabId.a.x = 88
    writePaneCanvasWorkspaceState(storage, 'ssh:host/worktree', state)

    expect(readPaneCanvasWorkspaceState(storage, 'ssh:host/worktree', ['a'])).toEqual(state)
    expect(storage.getItem(paneCanvasStorageKey('another-owner'))).toBeNull()
  })

  it('falls back safely for corrupt storage and sanitizes individual bounds', () => {
    const storage = memoryStorage()
    storage.setItem(paneCanvasStorageKey('broken'), '{ nope')
    expect(readPaneCanvasWorkspaceState(storage, 'broken', ['a']).mode).toBe('split')

    storage.setItem(
      paneCanvasStorageKey('partial'),
      JSON.stringify({
        mode: 'canvas',
        preferences: { snap: false },
        boundsByTerminalTabId: { a: { x: 'bad', y: 12, width: 4, height: 400 } }
      })
    )
    const partial = readPaneCanvasWorkspaceState(storage, 'partial', ['a'])
    expect(partial.mode).toBe('canvas')
    expect(partial).not.toHaveProperty('preferences')
    expect(partial.boundsByTerminalTabId.a).toMatchObject({
      x: 8,
      y: 12,
      width: 320,
      height: 400
    })
  })

  it('adds and prunes terminal geometry without moving retained cards', () => {
    const original = createPaneCanvasWorkspaceState(['a', 'b'])
    original.boundsByTerminalTabId.b.x = 904
    const reconciled = reconcilePaneCanvasWorkspaceState(original, ['b', 'c'])
    expect(Object.keys(reconciled.boundsByTerminalTabId)).toEqual(['b', 'c'])
    expect(reconciled.boundsByTerminalTabId.b.x).toBe(904)
  })

  it('places a new terminal clear of custom retained geometry', () => {
    const original = createPaneCanvasWorkspaceState(['a'])
    original.boundsByTerminalTabId.a = { x: 8, y: 8, width: 1200, height: 500 }
    const reconciled = reconcilePaneCanvasWorkspaceState(original, ['a', 'new-terminal'])
    expect(reconciled.boundsByTerminalTabId.a).toEqual(original.boundsByTerminalTabId.a)
    expect(reconciled.boundsByTerminalTabId['new-terminal'].y).toBeGreaterThan(500)
  })

  it('allows travel across panes and resolves an overlapping drop to nearby open space', () => {
    const requested = { x: 100, y: 100, width: 320, height: 220 }
    const resolved = resolvePaneCanvasDrop(requested, [{ x: 80, y: 80, width: 400, height: 300 }])
    expect(resolved).not.toEqual(requested)
  })

  it('moves a right-side overlap left when that is the nearest open space', () => {
    const requested = { x: 900, y: 100, width: 560, height: 360 }
    const resolved = resolvePaneCanvasDrop(requested, [{ x: 1000, y: 0, width: 560, height: 900 }])

    expect(resolved).toEqual({ x: 432, y: 100, width: 560, height: 360 })
  })
})

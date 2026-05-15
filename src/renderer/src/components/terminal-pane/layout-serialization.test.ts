/* oxlint-disable max-lines -- Why: this test keeps split layout replay fixtures together so
 * stable leaf-id migration regressions are visible in one focused suite. */
import { describe, expect, it, beforeAll } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Provide a minimal HTMLElement so `instanceof HTMLElement` passes in Node env
// ---------------------------------------------------------------------------
class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  dataset: Record<string, string>
  children: MockHTMLElement[]
  style: Record<string, string>
  firstElementChild: MockHTMLElement | null

  constructor(opts: {
    classList?: string[]
    dataset?: Record<string, string>
    children?: MockHTMLElement[]
    style?: Record<string, string>
    firstElementChild?: MockHTMLElement | null
  }) {
    const classes = opts.classList ?? []
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.dataset = opts.dataset ?? {}
    this.children = opts.children ?? []
    this.style = opts.style ?? {}
    this.firstElementChild = opts.firstElementChild ?? null
  }
}

beforeAll(() => {
  // Expose globally so `child instanceof HTMLElement` works inside the module
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = MockHTMLElement
})

import {
  buildFontFamily,
  serializePaneTree,
  serializeTerminalLayout,
  EMPTY_LAYOUT,
  collectLeafIdsInOrder,
  collectLeafIdsInReplayCreationOrder
} from './layout-serialization'

// ---------------------------------------------------------------------------
// Helper to create mock elements
// ---------------------------------------------------------------------------
function mockElement(opts: {
  classList?: string[]
  dataset?: Record<string, string>
  children?: MockHTMLElement[]
  style?: Record<string, string>
  firstElementChild?: MockHTMLElement | null
}): HTMLElement {
  return new MockHTMLElement(opts) as unknown as HTMLElement
}

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const LEAF_4 = '44444444-4444-4444-8444-444444444444'

// ---------------------------------------------------------------------------
// buildFontFamily
// ---------------------------------------------------------------------------
const FULL_FALLBACK =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('puts custom font first with full cross-platform fallback chain', () => {
    const result = buildFontFamily('JetBrains Mono')
    expect(result).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('does not duplicate SF Mono when it is the input', () => {
    const result = buildFontFamily('SF Mono')
    expect(result).toBe(
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('returns full fallback chain for empty string', () => {
    const result = buildFontFamily('')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    const result = buildFontFamily('   ')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('does not duplicate when font name contains "sf mono" (case-insensitive)', () => {
    const result = buildFontFamily('My SF Mono Custom')
    expect(result).toBe(
      '"My SF Mono Custom", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    const result = buildFontFamily('Consolas')
    expect(result).toBe(
      '"Consolas", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate MesloLGS Nerd Font when it is the input', () => {
    const result = buildFontFamily('MesloLGS Nerd Font')
    expect(result).toBe(
      '"MesloLGS Nerd Font", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })
})

// ---------------------------------------------------------------------------
// serializePaneTree
// ---------------------------------------------------------------------------
describe('serializePaneTree', () => {
  it('returns null for null input', () => {
    expect(serializePaneTree(null)).toBeNull()
  })

  it('returns a leaf node for a single pane', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: '1', leafId: LEAF_1 } })
    expect(serializePaneTree(pane)).toEqual({ type: 'leaf', leafId: LEAF_1 })
  })

  it('returns null for a pane without a UUID leaf id', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: 'abc' } })
    expect(serializePaneTree(pane)).toBeNull()
  })

  it('returns null for a pane with a legacy leaf id', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: '1', leafId: 'pane:1' } })
    expect(serializePaneTree(pane)).toBeNull()
  })

  it('returns null for element that is neither pane nor pane-split', () => {
    const el = mockElement({ classList: ['random-class'] })
    expect(serializePaneTree(el)).toBeNull()
  })

  it('returns a vertical split node with two pane children', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1', leafId: LEAF_1 }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2', leafId: LEAF_2 }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    })
  })

  it('returns horizontal direction when split has is-horizontal class', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '3', leafId: LEAF_3 }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '4', leafId: LEAF_4 }
    })
    const split = mockElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [first, second]
    })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LEAF_3 },
      second: { type: 'leaf', leafId: LEAF_4 }
    })
  })

  it('captures flex ratio when children have unequal flex', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1', leafId: LEAF_1 },
      style: { flex: '3' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2', leafId: LEAF_2 },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 },
      ratio: 0.75
    })
  })

  it('omits ratio when flex values are equal (both 1)', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1', leafId: LEAF_1 },
      style: { flex: '1' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2', leafId: LEAF_2 },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).not.toHaveProperty('ratio')
  })

  it('handles nested splits recursively', () => {
    const leaf1 = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1', leafId: LEAF_1 }
    })
    const leaf2 = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2', leafId: LEAF_2 }
    })
    const leaf3 = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '3', leafId: LEAF_3 }
    })

    const innerSplit = new MockHTMLElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [leaf2, leaf3]
    })
    const outerSplit = mockElement({
      classList: ['pane-split'],
      children: [leaf1, innerSplit]
    })

    expect(serializePaneTree(outerSplit)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeTerminalLayout
// ---------------------------------------------------------------------------
describe('serializeTerminalLayout', () => {
  it('returns EMPTY_LAYOUT equivalent when root is null', () => {
    const result = serializeTerminalLayout(null, null, null)
    expect(result).toEqual(EMPTY_LAYOUT)
  })

  it('returns null root when root has no firstElementChild', () => {
    const root = mockElement({}) as unknown as HTMLDivElement
    const result = serializeTerminalLayout(root, 5, null)
    expect(result).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    })
  })

  it('uses UUID leaf ids from the live pane map for active and expanded panes', () => {
    const child = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '5', leafId: LEAF_1 }
    })
    const root = mockElement({ firstElementChild: child }) as unknown as HTMLDivElement
    const result = serializeTerminalLayout(
      root,
      5,
      6,
      new Map([
        [5, LEAF_1],
        [6, LEAF_2]
      ])
    )
    expect(result).toEqual({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_2
    })
  })

  it('does not serialize legacy active pane ids when the live map is missing UUIDs', () => {
    const child = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '5', leafId: LEAF_1 }
    })
    const root = mockElement({ firstElementChild: child }) as unknown as HTMLDivElement
    const result = serializeTerminalLayout(
      root,
      5,
      6,
      new Map([
        [5, 'pane:5'],
        [6, 'pane:6']
      ])
    )
    expect(result).toEqual({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: null,
      expandedLeafId: null
    })
  })
})

// ---------------------------------------------------------------------------
// collectLeafIdsInReplayCreationOrder
// ---------------------------------------------------------------------------
describe('collectLeafIdsInReplayCreationOrder', () => {
  it('matches replayTerminalLayout pane creation order for nested left splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'A' },
        second: { type: 'leaf', leafId: 'B' }
      },
      second: { type: 'leaf', leafId: 'C' }
    }

    expect(collectLeafIdsInOrder(layout)).toEqual(['A', 'B', 'C'])
    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'C', 'B'])
  })

  it('matches replayTerminalLayout pane creation order for nested right splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'A' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'B' },
        second: { type: 'leaf', leafId: 'C' }
      }
    }

    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'B', 'C'])
  })
})

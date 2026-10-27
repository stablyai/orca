import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from './terminal-tab-types'
import {
  isRuntimePaneTitleOrphan,
  resolveRuntimePaneTitleForLeaf,
  resolveRuntimePaneTitleLeafResolution
} from './runtime-pane-title-leaf-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

const leafLayout: Pick<TerminalLayoutSnapshot, 'root'> = {
  root: { type: 'leaf', leafId: LEAF_A }
}

const splitLayout: Pick<TerminalLayoutSnapshot, 'root'> = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_A },
    second: { type: 'leaf', leafId: LEAF_B }
  }
}

describe('resolveRuntimePaneTitleForLeaf', () => {
  it('resolves split-pane titles to the matching leaf by replay order', () => {
    expect(resolveRuntimePaneTitleForLeaf(splitLayout, { 1: 'zsh', 2: 'Codex' }, LEAF_A)).toBe(
      'zsh'
    )
    expect(resolveRuntimePaneTitleForLeaf(splitLayout, { 1: 'zsh', 2: 'Codex' }, LEAF_B)).toBe(
      'Codex'
    )
  })

  it('uses a lone title when the tab has no resolved layout root', () => {
    expect(resolveRuntimePaneTitleForLeaf(undefined, { 7: 'Codex' }, LEAF_A)).toBe('Codex')
  })
})

describe('resolveRuntimePaneTitleLeafResolution', () => {
  it('reports when no pane titles are present', () => {
    expect(resolveRuntimePaneTitleLeafResolution(leafLayout, {}, LEAF_A)).toEqual({
      title: null,
      hasAnyPaneTitle: false
    })
  })

  it('reports an unrelated sparse split title without attributing it to the leaf', () => {
    expect(resolveRuntimePaneTitleLeafResolution(splitLayout, { 2: 'Codex' }, LEAF_A)).toEqual({
      title: null,
      hasAnyPaneTitle: true
    })
  })

  it('reports the matching leaf title when one resolves', () => {
    expect(
      resolveRuntimePaneTitleLeafResolution(splitLayout, { 1: 'zsh', 2: 'Codex' }, LEAF_B)
    ).toEqual({
      title: 'Codex',
      hasAnyPaneTitle: true
    })
  })
})

describe('isRuntimePaneTitleOrphan', () => {
  it('keeps ids the layout cannot place but that are not removed panes', () => {
    expect(isRuntimePaneTitleOrphan(leafLayout.root, '0')).toBe(false)
    expect(isRuntimePaneTitleOrphan(leafLayout.root, '-1')).toBe(false)
  })

  it('keeps a resolvable live pane', () => {
    expect(isRuntimePaneTitleOrphan(splitLayout.root, '2')).toBe(false)
    expect(isRuntimePaneTitleOrphan(splitLayout.root, LEAF_B)).toBe(false)
  })

  it('flags a leaf id and an out-of-range slot the layout no longer has', () => {
    expect(isRuntimePaneTitleOrphan(leafLayout.root, LEAF_B)).toBe(true)
    expect(isRuntimePaneTitleOrphan(leafLayout.root, '2')).toBe(true)
  })
})

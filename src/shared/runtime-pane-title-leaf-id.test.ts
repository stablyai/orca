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
  it('never treats numeric slots as removed panes', () => {
    for (const runtimePaneId of ['0', '-1', '2', '3']) {
      expect(isRuntimePaneTitleOrphan(runtimePaneId, new Set([LEAF_A]))).toBe(false)
    }
  })

  it('flags only a durable leaf id the layout no longer has', () => {
    expect(isRuntimePaneTitleOrphan(LEAF_B, new Set([LEAF_A, LEAF_B]))).toBe(false)
    expect(isRuntimePaneTitleOrphan(LEAF_B, new Set([LEAF_A]))).toBe(true)
  })
})

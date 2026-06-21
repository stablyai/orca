import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/types'
import { resolveRuntimePaneTitleForLeaf } from './runtime-pane-title-leaf-id'

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
  it('returns null when no pane titles are present', () => {
    expect(resolveRuntimePaneTitleForLeaf(leafLayout, undefined, LEAF_A)).toBeNull()
    expect(resolveRuntimePaneTitleForLeaf(leafLayout, {}, LEAF_A)).toBeNull()
  })

  it('maps a single-leaf pane title to its leaf', () => {
    expect(resolveRuntimePaneTitleForLeaf(leafLayout, { 1: 'Codex' }, LEAF_A)).toBe('Codex')
  })

  it('resolves split-pane titles to the matching leaf by replay order', () => {
    expect(resolveRuntimePaneTitleForLeaf(splitLayout, { 1: 'zsh', 2: 'Codex' }, LEAF_A)).toBe(
      'zsh'
    )
    expect(resolveRuntimePaneTitleForLeaf(splitLayout, { 1: 'zsh', 2: 'Codex' }, LEAF_B)).toBe(
      'Codex'
    )
  })

  it('does not attribute a lone background split title to an unrelated leaf', () => {
    expect(resolveRuntimePaneTitleForLeaf(splitLayout, { 2: 'Codex' }, LEAF_A)).toBeNull()
  })

  it('uses a lone title when the tab has no resolved layout root', () => {
    expect(resolveRuntimePaneTitleForLeaf(undefined, { 7: 'Codex' }, LEAF_A)).toBe('Codex')
  })
})

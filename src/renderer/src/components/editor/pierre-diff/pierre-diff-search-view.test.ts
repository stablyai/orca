// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { paintPierreSearchHighlights, pierreSearchRevealLine } from './pierre-diff-search-view'
import { buildPierreFileDiff } from './pierre-diff-metadata'

const input = {
  path: 'file.ts',
  status: 'modified',
  cacheKey: 'search-view',
  parseDiffOptions: {}
}

it('passes addition-side matches through unchanged', () => {
  const diff = buildPierreFileDiff({
    ...input,
    originalContent: 'a\n',
    modifiedContent: 'b\n'
  })
  expect(pierreSearchRevealLine(diff, 1, 'additions')).toBe(1)
})

it('does not feed a pure-deletion line number to revealLine', () => {
  const diff = buildPierreFileDiff({
    ...input,
    originalContent: `${'keep\n'.repeat(40)}${'drop\n'.repeat(10)}GONE\n${'keep\n'.repeat(40)}old\n`,
    modifiedContent: `${'keep\n'.repeat(80)}new\n`
  })
  const goneLine = 51
  const hunk = diff.hunks[0]
  const additionEnd = hunk.additionStart + hunk.additionCount
  expect(goneLine).toBeGreaterThan(additionEnd)
  const revealed = pierreSearchRevealLine(diff, goneLine, 'deletions')
  expect(revealed).not.toBe(goneLine)
  expect(revealed).toBeGreaterThanOrEqual(hunk.additionStart)
  expect(revealed).toBeLessThanOrEqual(additionEnd)
})

it('maps a fully deleted file onto the empty new-file hunk start', () => {
  const diff = buildPierreFileDiff({
    ...input,
    status: 'deleted',
    originalContent: `${'keep\n'.repeat(40)}${'drop\n'.repeat(10)}GONE\n${'keep\n'.repeat(40)}old\n`,
    modifiedContent: ''
  })
  expect(diff.additionLines).toHaveLength(0)
  expect(diff.hunks[0]?.additionStart).toBe(0)
  expect(diff.hunks[0]?.additionCount).toBe(0)
  // FileDiff.revealLine uses 1-based new-file ranges; +0,0 becomes [1, 1).
  expect(pierreSearchRevealLine(diff, 51, 'deletions')).toBe(1)
})

it('leaves active highlights untouched when an unrelated surface removes no ranges', () => {
  const registry = new Map<string, Set<Range>>()
  vi.stubGlobal('Highlight', class extends Set<Range> {})
  vi.stubGlobal('CSS', { highlights: registry })
  const owner = Symbol()
  try {
    paintPierreSearchHighlights(owner, { matches: [document.createRange()], active: [] })
    const active = registry.get('orca-diff-find')
    for (let row = 0; row < 10; row++) {
      paintPierreSearchHighlights(Symbol())
    }
    expect(registry.get('orca-diff-find')).toBe(active)
    paintPierreSearchHighlights(owner)
    expect(registry.has('orca-diff-find')).toBe(false)
  } finally {
    paintPierreSearchHighlights(owner)
    vi.unstubAllGlobals()
  }
})

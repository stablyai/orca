import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'
import {
  isUnchangedDiffSectionReload,
  shouldRequestCombinedDiffSectionLoad
} from './combined-diff-section-load-state'

function textDiff(originalContent: string, modifiedContent: string): GitDiffResult {
  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

function limitedRenderLimit(
  overrides: Partial<Extract<LargeDiffRenderLimit, { limited: true }>> = {}
): LargeDiffRenderLimit {
  return {
    limited: true,
    reason: 'line-count',
    lineCounts: null,
    characterCount: 0,
    limits: { maxLinesPerSide: 1, maxCombinedCharacters: 1 },
    ...overrides
  }
}

function renderLimit(limited: boolean): LargeDiffRenderLimit {
  return limited
    ? limitedRenderLimit()
    : { limited: false, lineCounts: { original: 1, modified: 1 }, characterCount: 2 }
}

function loaded(
  originalContent: string,
  modifiedContent: string,
  overrides: {
    error?: string
    limited?: boolean
    diffResult?: GitDiffResult
    largeDiffRenderLimit?: LargeDiffRenderLimit
  } = {}
): Parameters<typeof isUnchangedDiffSectionReload>[0] {
  return {
    diffResult: overrides.diffResult ?? textDiff(originalContent, modifiedContent),
    error: overrides.error,
    largeDiffRenderLimit: overrides.largeDiffRenderLimit ?? renderLimit(overrides.limited ?? false),
    originalContent,
    modifiedContent
  }
}

// Limited sections store empty content, so every case below turns on render-limit metadata alone.
function limited(largeDiffRenderLimit: LargeDiffRenderLimit) {
  return loaded('', '', { largeDiffRenderLimit })
}

describe('combined diff section load state', () => {
  it('requests content when a stale loaded marker has no diff result', () => {
    expect(
      shouldRequestCombinedDiffSectionLoad({ diffResult: null, error: undefined }, false)
    ).toBe(true)
  })

  it('preserves loaded and actively loading sections', () => {
    expect(
      shouldRequestCombinedDiffSectionLoad(
        {
          diffResult: {
            kind: 'text',
            originalContent: 'before',
            modifiedContent: 'after',
            originalIsBinary: false,
            modifiedIsBinary: false
          },
          error: undefined
        },
        false
      )
    ).toBe(false)
    expect(shouldRequestCombinedDiffSectionLoad({ diffResult: null, error: undefined }, true)).toBe(
      false
    )
  })
})

describe('isUnchangedDiffSectionReload', () => {
  it('skips a revalidation that refetched the same text', () => {
    expect(isUnchangedDiffSectionReload(loaded('before', 'after'), loaded('before', 'after'))).toBe(
      true
    )
  })

  it('commits when either side of the content moved', () => {
    expect(
      isUnchangedDiffSectionReload(loaded('before', 'after'), loaded('before', 'rebased'))
    ).toBe(false)
    expect(
      isUnchangedDiffSectionReload(loaded('before', 'after'), loaded('rebased', 'after'))
    ).toBe(false)
  })

  it('commits when the error state changes in either direction', () => {
    expect(
      isUnchangedDiffSectionReload(loaded('a', 'b'), loaded('a', 'b', { error: 'boom' }))
    ).toBe(false)
    expect(
      isUnchangedDiffSectionReload(loaded('a', 'b', { error: 'boom' }), loaded('a', 'b'))
    ).toBe(false)
  })

  it('commits when the render limit crosses the fallback boundary', () => {
    expect(
      isUnchangedDiffSectionReload(loaded('a', 'b'), loaded('a', 'b', { limited: true }))
    ).toBe(false)
  })

  it('skips a limited reload whose render-limit metadata is identical', () => {
    const unchanged = limitedRenderLimit({ lineCounts: { original: 400_000, modified: 400_000 } })
    expect(isUnchangedDiffSectionReload(limited(unchanged), limited(unchanged))).toBe(true)
  })

  it('commits when a limited reload moves line counts', () => {
    expect(
      isUnchangedDiffSectionReload(
        limited(limitedRenderLimit({ lineCounts: { original: 400_000, modified: 400_000 } })),
        limited(limitedRenderLimit({ lineCounts: { original: 400_000, modified: 401_000 } }))
      )
    ).toBe(false)
    expect(
      isUnchangedDiffSectionReload(
        limited(limitedRenderLimit({ lineCounts: null })),
        limited(limitedRenderLimit({ lineCounts: { original: 400_000, modified: 400_000 } }))
      )
    ).toBe(false)
  })

  it('commits when a limited reload moves the character count or reason', () => {
    expect(
      isUnchangedDiffSectionReload(
        limited(limitedRenderLimit({ characterCount: 7_000_000 })),
        limited(limitedRenderLimit({ characterCount: 9_000_000 }))
      )
    ).toBe(false)
    expect(
      isUnchangedDiffSectionReload(
        limited(limitedRenderLimit({ reason: 'line-count' })),
        limited(limitedRenderLimit({ reason: 'character-count' }))
      )
    ).toBe(false)
  })

  it('commits when a limited reload stops reporting line counts as a floor', () => {
    expect(
      isUnchangedDiffSectionReload(
        limited(
          limitedRenderLimit({
            lineCounts: { original: 120_001, modified: 0 },
            lineCountsAreMinimum: { original: true, modified: false }
          })
        ),
        limited(limitedRenderLimit({ lineCounts: { original: 120_001, modified: 0 } }))
      )
    ).toBe(false)
  })

  it('never skips binary results, whose payload it cannot compare', () => {
    const binary: GitDiffResult = {
      kind: 'binary',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: true,
      modifiedIsBinary: true
    }
    expect(
      isUnchangedDiffSectionReload(
        loaded('', '', { diffResult: binary }),
        loaded('', '', { diffResult: binary })
      )
    ).toBe(false)
  })
})

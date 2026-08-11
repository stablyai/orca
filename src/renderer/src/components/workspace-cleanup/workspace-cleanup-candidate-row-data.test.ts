import { describe, expect, it } from 'vitest'
import { getDirtyGitLabel, shouldShowGitMetadataChip } from './workspace-cleanup-candidate-row-data'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

describe('workspace cleanup candidate row data', () => {
  it('does not duplicate git status blockers as a separate git icon label', () => {
    const gitStatusError = makeCandidate({
      blockers: ['git-status-error'],
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
    })
    const unknownBase = makeCandidate({
      blockers: ['unknown-base'],
      git: { clean: true, upstreamAhead: null, upstreamBehind: null, checkedAt: 1 }
    })

    expect(getDirtyGitLabel(gitStatusError)).toBeNull()
    expect(shouldShowGitMetadataChip(gitStatusError)).toBe(false)
    expect(getDirtyGitLabel(unknownBase)).toBeNull()
    expect(shouldShowGitMetadataChip(unknownBase)).toBe(false)
  })

  it('keeps the git metadata chip for ordinary clean rows', () => {
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
        })
      )
    ).toBe(true)
  })

  it('suppresses the git metadata chip when the status pill already names git risk', () => {
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          blockers: ['unpushed-commits'],
          git: { clean: true, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 1 }
        })
      )
    ).toBe(false)
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          tier: 'review',
          blockers: [],
          git: { clean: true, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 1 }
        })
      )
    ).toBe(false)
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          blockers: ['dirty-files'],
          git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
        })
      )
    ).toBe(false)
  })
})

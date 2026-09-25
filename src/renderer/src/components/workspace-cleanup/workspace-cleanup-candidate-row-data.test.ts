import { describe, expect, it } from 'vitest'
import {
  getCandidateFactStatuses,
  getDirtyGitLabel,
  shouldShowGitMetadataChip
} from './workspace-cleanup-candidate-row-data'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

describe('workspace cleanup candidate row data', () => {
  it('shows facts instead of cleanup policy tiers', () => {
    expect(getCandidateFactStatuses(makeCandidate({ tier: 'ready' }))).toEqual([])
    expect(getCandidateFactStatuses(makeCandidate({ tier: 'review' }))).toEqual([])
    expect(getCandidateFactStatuses(makeCandidate({ reasons: ['archived'] }))).toContainEqual(
      expect.objectContaining({ label: 'Archived' })
    )
  })

  it('does not duplicate git status blockers as a separate git icon label', () => {
    const gitStatusError = makeCandidate({
      blockers: ['git-status-error'],
      git: {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      }
    })
    const unknownBase = makeCandidate({
      blockers: ['unknown-base'],
      git: {
        clean: true,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: 1
      }
    })

    expect(getDirtyGitLabel(gitStatusError)).toBe('Git status check failed')
    expect(shouldShowGitMetadataChip(gitStatusError)).toBe(false)
    expect(getDirtyGitLabel(unknownBase)).toBe('Git status could not be verified')
    expect(shouldShowGitMetadataChip(unknownBase)).toBe(false)
  })

  it('keeps the git metadata chip for ordinary clean rows', () => {
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          git: {
            clean: true,
            upstreamAhead: 0,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toBe(true)
  })

  it('keeps unpushed risk visible for archived rows', () => {
    expect(
      getCandidateFactStatuses(
        makeCandidate({
          tier: 'review',
          reasons: ['archived'],
          git: {
            clean: true,
            upstreamAhead: 2,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toContainEqual(expect.objectContaining({ label: 'Unpushed commits' }))
  })

  it('renders every blocker fact instead of only the first', () => {
    expect(
      getCandidateFactStatuses(makeCandidate({ blockers: ['pinned', 'git-status-error'] }))
    ).toEqual([
      expect.objectContaining({ label: 'Pinned' }),
      expect.objectContaining({
        label: 'Git status unavailable',
        tone: 'destructive'
      })
    ])
  })

  it('suppresses the git metadata chip when the status pill already names git risk', () => {
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          blockers: ['unpushed-commits'],
          git: {
            clean: true,
            upstreamAhead: 2,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toBe(false)
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          tier: 'review',
          blockers: [],
          git: {
            clean: true,
            upstreamAhead: 2,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toBe(false)
    expect(
      shouldShowGitMetadataChip(
        makeCandidate({
          blockers: ['dirty-files'],
          git: {
            clean: false,
            upstreamAhead: 0,
            upstreamBehind: 0,
            checkedAt: 1
          }
        })
      )
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { shouldShowComposerBaseRefPicker } from './base-ref-picker-visibility'

const gitRepo = { selectedRepoIsGit: true, branchesEnabled: true }

describe('shouldShowComposerBaseRefPicker', () => {
  it('offers a base ref when no source is selected yet', () => {
    expect(shouldShowComposerBaseRefPicker({ ...gitRepo, smartNameSelectionKind: null })).toBe(true)
  })

  it.each(['github-issue', 'gitlab-issue', 'linear', 'jira'] as const)(
    'offers a base ref for a %s source',
    (smartNameSelectionKind) => {
      expect(shouldShowComposerBaseRefPicker({ ...gitRepo, smartNameSelectionKind })).toBe(true)
    }
  )

  it.each(['github-pr', 'gitlab-mr', 'branch'] as const)(
    'hides the base ref for a %s source that carries its own base',
    (smartNameSelectionKind) => {
      expect(shouldShowComposerBaseRefPicker({ ...gitRepo, smartNameSelectionKind })).toBe(false)
    }
  )

  it('hides the base ref for a non-git project', () => {
    expect(
      shouldShowComposerBaseRefPicker({
        selectedRepoIsGit: false,
        branchesEnabled: true,
        smartNameSelectionKind: 'jira'
      })
    ).toBe(false)
  })

  it('hides the base ref when branches are disabled, as on a folder workspace', () => {
    expect(
      shouldShowComposerBaseRefPicker({
        selectedRepoIsGit: true,
        branchesEnabled: false,
        smartNameSelectionKind: 'jira'
      })
    ).toBe(false)
  })
})

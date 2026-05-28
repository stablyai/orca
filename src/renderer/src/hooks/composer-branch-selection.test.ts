import { describe, expect, it } from 'vitest'
import { resolveComposerBranchSelection } from './composer-branch-selection'

describe('resolveComposerBranchSelection', () => {
  it('keeps selected remote ref as base while using the local branch name for create', () => {
    expect(
      resolveComposerBranchSelection({
        refName: 'origin/feature/something',
        localBranchName: 'feature/something',
        currentName: '',
        lastAutoName: ''
      })
    ).toEqual({
      baseBranch: 'origin/feature/something',
      branchNameOverride: 'feature/something',
      branchAutoName: 'feature/something',
      name: 'feature/something',
      lastAutoName: 'feature/something'
    })
  })

  it('does not override a user-edited workspace name', () => {
    expect(
      resolveComposerBranchSelection({
        refName: 'origin/feature/something',
        localBranchName: 'feature/something',
        currentName: 'custom-name',
        lastAutoName: 'previous-auto'
      })
    ).toMatchObject({
      baseBranch: 'origin/feature/something',
      branchNameOverride: undefined,
      name: undefined
    })
  })

  it('replaces a typed branch prefix with the selected branch name', () => {
    expect(
      resolveComposerBranchSelection({
        refName: 'fix/bug-0',
        localBranchName: 'fix/bug-0',
        currentName: 'fix/bug',
        lastAutoName: ''
      })
    ).toEqual({
      baseBranch: 'fix/bug-0',
      branchNameOverride: 'fix/bug-0',
      branchAutoName: 'fix/bug-0',
      name: 'fix/bug-0',
      lastAutoName: 'fix/bug-0'
    })
  })
})

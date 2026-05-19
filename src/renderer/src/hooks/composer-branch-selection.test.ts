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
})

import { describe, expect, it } from 'vitest'
import {
  getComposerRepoWorktreeBranches,
  isBranchCheckedOutInWorktrees,
  resolveComposerBranchNameOverrideForCreate,
  resolveComposerBranchReuse,
  resolveComposerBranchSelection,
  resolveComposerManualBranchNameChange,
  resolveComposerReuseOverride
} from './composer-branch-selection'

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

  it('keeps manual branch-name overrides when preserving workspace edits', () => {
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: 'feature/manual',
        branchAutoName: 'feature/auto',
        workspaceName: 'edited display name',
        preserveWorkspaceNameEdits: true
      })
    ).toBe('feature/manual')
  })

  it('drops empty or missing branch-name overrides even when preserving workspace edits', () => {
    for (const branchNameOverride of [undefined, '']) {
      expect(
        resolveComposerBranchNameOverrideForCreate({
          branchNameOverride,
          branchAutoName: 'feature/fix',
          workspaceName: 'edited display name',
          preserveWorkspaceNameEdits: true
        })
      ).toBeUndefined()
    }
  })

  it('keeps existing branch picker override behavior tied to the auto-name', () => {
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: 'feature/fix',
        branchAutoName: 'feature/fix',
        workspaceName: 'edited display name',
        preserveWorkspaceNameEdits: false
      })
    ).toBeUndefined()
  })

  it('uses a slash-containing typed branch name as the create override in branch mode', () => {
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: undefined,
        branchAutoName: '',
        workspaceName: 'feature/user-profile',
        preserveWorkspaceNameEdits: false,
        createBranchFromWorkspaceName: true
      })
    ).toBe('feature/user-profile')
  })

  it('keeps plain typed branch names on the existing sanitized-name path', () => {
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: undefined,
        branchAutoName: '',
        workspaceName: 'feature-user-profile',
        preserveWorkspaceNameEdits: false,
        createBranchFromWorkspaceName: true
      })
    ).toBeUndefined()
  })

  it('does not preserve a slash typed name outside branch mode (gate off)', () => {
    // Only branch mode preserves slashes; other modes sanitize the workspace name.
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: undefined,
        branchAutoName: '',
        workspaceName: 'feature/user-profile',
        preserveWorkspaceNameEdits: false,
        createBranchFromWorkspaceName: false
      })
    ).toBeUndefined()
  })

  it('keeps a resolver-provided override even in branch mode with a slash name', () => {
    // Explicit picked-branch overrides must beat typed branch-mode names.
    expect(
      resolveComposerBranchNameOverrideForCreate({
        branchNameOverride: 'feature/picked',
        branchAutoName: 'feature/picked',
        workspaceName: 'feature/user-profile',
        preserveWorkspaceNameEdits: true,
        createBranchFromWorkspaceName: true
      })
    ).toBe('feature/picked')
  })
})

describe('resolveComposerManualBranchNameChange', () => {
  const forkPushTarget = {
    remoteName: 'contributor',
    branchName: 'feature/from-pr',
    remoteUrl: 'https://example.com/contributor/repo.git'
  }

  it('clears a PR-derived push target when the manual branch changes to a different branch', () => {
    expect(
      resolveComposerManualBranchNameChange({
        value: 'feature/manual',
        pushTarget: forkPushTarget,
        forkPushWarning: 'Cannot push to fork'
      })
    ).toEqual({
      branchNameOverride: 'feature/manual',
      pushTarget: undefined,
      forkPushWarning: null
    })
  })

  it('clears a PR-derived push target when manual branch input is empty or whitespace', () => {
    for (const value of ['', '   ']) {
      expect(
        resolveComposerManualBranchNameChange({
          value,
          pushTarget: forkPushTarget,
          forkPushWarning: 'Cannot push to fork'
        })
      ).toEqual({
        branchNameOverride: undefined,
        pushTarget: undefined,
        forkPushWarning: null
      })
    }
  })

  it('preserves a PR-derived push target when the manual branch exactly matches its branch', () => {
    expect(
      resolveComposerManualBranchNameChange({
        value: 'feature/from-pr',
        pushTarget: forkPushTarget,
        forkPushWarning: 'Cannot push to fork'
      })
    ).toEqual({
      branchNameOverride: 'feature/from-pr',
      pushTarget: forkPushTarget,
      forkPushWarning: 'Cannot push to fork'
    })
  })
})

describe('isBranchCheckedOutInWorktrees', () => {
  it('matches a branch against both refs/heads-qualified and short worktree refs', () => {
    expect(
      isBranchCheckedOutInWorktrees('feature-x', ['refs/heads/main', 'refs/heads/feature-x'])
    ).toBe(true)
    expect(isBranchCheckedOutInWorktrees('feature-x', ['feature-x'])).toBe(true)
    expect(isBranchCheckedOutInWorktrees('feature-x', ['refs/heads/main', ''])).toBe(false)
    expect(isBranchCheckedOutInWorktrees('feature-x', [])).toBe(false)
  })
})

describe('getComposerRepoWorktreeBranches', () => {
  it('supplies only the selected repo branches to reuse eligibility', () => {
    expect(
      getComposerRepoWorktreeBranches(
        [
          { repoId: 'repo-a', branch: 'feature/a' },
          { repoId: 'repo-b', branch: 'feature/b' }
        ],
        'repo-a'
      )
    ).toEqual(['feature/a'])
  })
})

describe('resolveComposerReuseOverride', () => {
  it('keeps the selection override for a reusable (non-busy) local branch', () => {
    expect(
      resolveComposerReuseOverride({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        branchNameOverride: 'feature-x',
        branchCheckedOutElsewhere: false
      })
    ).toBe('feature-x')
  })

  it('drops the override for a local branch checked out in another worktree', () => {
    // Why: pinning a busy branch would collide and produce a suffixed branch.
    expect(
      resolveComposerReuseOverride({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        branchNameOverride: 'feature-x',
        branchCheckedOutElsewhere: true
      })
    ).toBeUndefined()
  })

  it('drops the branch-off override when the remote branch has a busy local copy', () => {
    // Remote-only refs need fresh local tracking branches; local-name busy checks must preserve their override.
    expect(
      resolveComposerReuseOverride({
        refName: 'origin/feature-x',
        localBranchName: 'feature-x',
        branchNameOverride: 'feature-x',
        branchCheckedOutElsewhere: true
      })
    ).toBeUndefined()
  })
})

describe('resolveComposerBranchReuse', () => {
  it('offers reuse for qualified local and remote selectors', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'refs/heads/feature/加',
        localBranchName: 'feature/加',
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature/加', defaultReuse: true })
    expect(
      resolveComposerBranchReuse({
        refName: 'refs/remotes/origin/feature/加',
        localBranchName: 'feature/加',
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature/加', defaultReuse: true })
    expect(
      resolveComposerReuseOverride({
        refName: 'refs/heads/feature/加',
        localBranchName: 'feature/加',
        branchNameOverride: 'feature/加',
        branchCheckedOutElsewhere: true
      })
    ).toBeUndefined()
  })
  it('marks an existing local branch reusable and defaults reuse ON for an auto-derived name', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature-x', defaultReuse: true })
  })

  it('offers reuse for a remote-only ref', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'origin/feature/something',
        localBranchName: 'feature/something',
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature/something', defaultReuse: true })
  })

  it('retains reuse intent for a busy branch so the host can report or open its workspace', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        branchCheckedOutElsewhere: true
      })
    ).toEqual({ reuseEligibleBranch: 'feature-x', defaultReuse: true })
  })
})

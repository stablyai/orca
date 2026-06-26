import { describe, expect, it } from 'vitest'
import {
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

  it('keeps the override for a remote-only ref even if its local name is busy', () => {
    // Why: a remote-only ref (ref !== local name) creates a fresh local tracking
    // branch, so the busy check on the local name must not drop its override.
    expect(
      resolveComposerReuseOverride({
        refName: 'origin/feature-x',
        localBranchName: 'feature-x',
        branchNameOverride: 'feature-x',
        branchCheckedOutElsewhere: true
      })
    ).toBe('feature-x')
  })
})

describe('resolveComposerBranchReuse', () => {
  it('marks an existing local branch reusable and defaults reuse ON for an auto-derived name', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        selectionProducedOverride: true,
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature-x', defaultReuse: true })
  })

  it('treats a slash-containing local branch as reusable (ref equals local name)', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'fix/bug-0',
        localBranchName: 'fix/bug-0',
        selectionProducedOverride: true,
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'fix/bug-0', defaultReuse: true })
  })

  it('does not offer reuse for a remote-only ref (ref carries an origin/ prefix)', () => {
    expect(
      resolveComposerBranchReuse({
        refName: 'origin/feature/something',
        localBranchName: 'feature/something',
        selectionProducedOverride: true,
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: null, defaultReuse: false })
  })

  it('does not offer reuse when the branch is already checked out in another worktree', () => {
    // Why: git refuses a branch in two worktrees, so reuse is impossible here.
    expect(
      resolveComposerBranchReuse({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        selectionProducedOverride: true,
        branchCheckedOutElsewhere: true
      })
    ).toEqual({ reuseEligibleBranch: null, defaultReuse: false })
  })

  it('keeps a local branch reuse-eligible but defaults reuse OFF when the user typed a custom name', () => {
    // Why: no override means the user is branching off the ref with a custom
    // worktree name; reuse stays opt-in (checkbox still shown via eligibility).
    expect(
      resolveComposerBranchReuse({
        refName: 'feature-x',
        localBranchName: 'feature-x',
        selectionProducedOverride: false,
        branchCheckedOutElsewhere: false
      })
    ).toEqual({ reuseEligibleBranch: 'feature-x', defaultReuse: false })
  })
})

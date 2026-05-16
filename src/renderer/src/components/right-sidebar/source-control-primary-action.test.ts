/* eslint-disable max-lines -- Why: this state-machine table intentionally keeps every primary-action priority case together so merge regressions are visible in one file. */
import { describe, expect, it } from 'vitest'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'

// Why: a shared defaults object keeps each case row terse while making the
// "this is the one knob that differs from the baseline" intent obvious.
function inputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: undefined,
    ...overrides
  }
}

const upstreamInSync = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 0,
  behind: 0
}

describe('resolvePrimaryAction', () => {
  it('returns a disabled Commit while a commit is in flight', () => {
    const result = resolvePrimaryAction(
      inputs({ isCommitting: true, stagedCount: 1, hasMessage: true })
    )
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Commit in progress…',
      disabled: true
    })
  })

  it('keeps the contextual label but disables it while a remote op is in flight', () => {
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 }
      })
    )
    expect(result).toEqual({
      kind: 'pull',
      label: 'Pull',
      title: 'Remote operation in progress…',
      disabled: true
    })
  })

  // Why: when the user picks an action from the dropdown that doesn't match
  // the primary's natural label, the primary must mirror the user-triggered
  // action (label + kind) so the spinner narrates the right thing. Without
  // this, picking "Sync" from the dropdown while the primary reads "Push"
  // would spin a "Push" button that is not actually pushing.
  it('mirrors the in-flight remote op kind on the primary while a remote op runs', () => {
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        // Pre-click natural state would resolve to Push (ahead-only).
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
        inFlightRemoteOpKind: 'sync'
      })
    )
    expect(result).toEqual({
      kind: 'sync',
      label: 'Sync',
      title: 'Sync in progress…',
      disabled: true
    })
  })

  it('mirrors an in-flight Pull on the primary even when natural label is Push', () => {
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
        inFlightRemoteOpKind: 'pull'
      })
    )
    expect(result.kind).toBe('pull')
    expect(result.label).toBe('Pull')
    expect(result.title).toBe('Pull in progress…')
    expect(result.disabled).toBe(true)
  })

  it('keeps the natural Publish label and tooltip when an in-flight Publish matches', () => {
    // Why: when the in-flight kind matches the natural primary kind we
    // preserve the candidate's full label (the natural state-machine row
    // owns the wording) rather than overriding to a stripped-down version.
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        inFlightRemoteOpKind: 'publish'
      })
    )
    expect(result.kind).toBe('publish')
    expect(result.label).toBe('Publish Branch')
    expect(result.title).toBe('Remote operation in progress…')
    expect(result.disabled).toBe(true)
  })

  // Why: Fetch is dropdown-only and never appears as the primary's label.
  // When fetch is in flight, the primary must keep its natural label and
  // tooltip so the button doesn't claim "Fetch" is a primary action — and
  // the CommitArea spinner suppression hangs off the kind mismatch.
  it('keeps the natural primary label when an in-flight Fetch is dropdown-only', () => {
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 },
        inFlightRemoteOpKind: 'fetch'
      })
    )
    expect(result).toEqual({
      kind: 'push',
      label: 'Push',
      title: 'Remote operation in progress…',
      disabled: true
    })
  })

  it('blocks commits while unresolved conflicts exist', () => {
    const result = resolvePrimaryAction(
      inputs({ hasUnresolvedConflicts: true, stagedCount: 2, hasMessage: true })
    )
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Resolve conflicts before committing',
      disabled: true
    })
  })

  // Why: the primary button never compounds ("Commit & Push" etc.) — it
  // always reads "Commit" whenever there are staged files with a message,
  // regardless of remote state. Compound flows remain available from the
  // dropdown; after the commit lands, the primary naturally rotates to
  // Push / Sync / Publish Branch.
  it('returns plain Commit for staged+message regardless of upstream state', () => {
    const upstreams = [
      undefined,
      { hasUpstream: false as const, ahead: 0, behind: 0 },
      { hasUpstream: true as const, ahead: 0, behind: 0 },
      { hasUpstream: true as const, ahead: 3, behind: 0 },
      { hasUpstream: true as const, ahead: 2, behind: 1 },
      { hasUpstream: true as const, ahead: 0, behind: 4 }
    ]
    for (const upstreamStatus of upstreams) {
      const result = resolvePrimaryAction(
        inputs({ stagedCount: 1, hasMessage: true, upstreamStatus })
      )
      expect(result.kind).toBe('commit')
      expect(result.label).toBe('Commit')
      expect(result.disabled).toBe(false)
    }
  })

  it('disables Commit with a message-needed hint when staged but no message', () => {
    const result = resolvePrimaryAction(inputs({ stagedCount: 1, hasMessage: false }))
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Enter a commit message to commit',
      disabled: true
    })
  })

  it('returns Publish Branch on a clean tree when no upstream exists', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } })
    )
    expect(result).toEqual({
      kind: 'publish',
      label: 'Publish Branch',
      title: 'Publish this branch to origin',
      disabled: false
    })
  })

  it.each([
    [{ prState: 'merged' as const }, 'Nothing to commit. PR is already merged.'],
    [{ isPRStateLoading: true }, 'Checking PR status…']
  ])('does not offer Publish Branch when linked PR state blocks it', (overrides, title) => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }, ...overrides })
    )
    expect(result).toEqual({ kind: 'commit', label: 'Commit', title, disabled: true })
  })

  it('returns Sync when clean + tracked + diverged both ways', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 } })
    )
    expect(result).toEqual({
      kind: 'sync',
      label: 'Sync',
      title: 'Pull 3, push 2',
      disabled: false
    })
  })

  it('returns Pull when clean + behind-only', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 4 } })
    )
    expect(result.kind).toBe('pull')
    expect(result.label).toBe('Pull')
    expect(result.title).toBe('Pull 4 commits')
  })

  it('uses singular copy for a single-commit pull', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 1 } })
    )
    expect(result.title).toBe('Pull 1 commit')
  })

  it('returns Push when clean + ahead-only', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 } })
    )
    expect(result).toEqual({
      kind: 'push',
      label: 'Push',
      title: 'Push 3 commits',
      disabled: false
    })
  })

  it('returns a disabled up-to-date Commit when tracked branch is clean and in sync', () => {
    const result = resolvePrimaryAction(inputs({ upstreamStatus: upstreamInSync }))
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Nothing to commit. Branch is up to date.',
      disabled: true
    })
  })

  // Why: dirty trees (no staged, has unstaged/untracked) must surface a
  // 'Stage Files' primary regardless of upstream state. Pulling/syncing on
  // a dirty tree fails ("Please commit or stash them"), and pushing skips
  // the immediate user need (prepare a commit), so the staging rung
  // intercepts before any remote rung fires.
  it('returns Stage Files on a dirty tree that is behind upstream', () => {
    const result = resolvePrimaryAction(
      inputs({
        hasUnstagedChanges: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 }
      })
    )
    expect(result).toEqual({
      kind: 'stage',
      label: 'Stage Files',
      title: 'Stage all changes',
      disabled: false
    })
  })

  it('returns Stage Files on a dirty tree that is ahead of upstream', () => {
    const result = resolvePrimaryAction(
      inputs({
        hasUnstagedChanges: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
      })
    )
    expect(result.kind).toBe('stage')
    expect(result.label).toBe('Stage Files')
    expect(result.disabled).toBe(false)
  })

  it('returns Stage Files on a dirty tree with no upstream branch', () => {
    const result = resolvePrimaryAction(
      inputs({
        hasUnstagedChanges: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
      })
    )
    expect(result.kind).toBe('stage')
  })

  it('returns Stage Files on a dirty tree while upstream status is still loading', () => {
    const result = resolvePrimaryAction(
      inputs({ hasUnstagedChanges: true, upstreamStatus: undefined })
    )
    expect(result.kind).toBe('stage')
    expect(result.disabled).toBe(false)
  })

  it('still resolves to Commit when both staged and unstaged exist (staged wins)', () => {
    const result = resolvePrimaryAction(
      inputs({
        stagedCount: 1,
        hasUnstagedChanges: true,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    expect(result.kind).toBe('commit')
    expect(result.disabled).toBe(false)
  })

  it('still disables Commit (needs message) when staged+dirty without a message', () => {
    const result = resolvePrimaryAction(
      inputs({ stagedCount: 1, hasUnstagedChanges: true, hasMessage: false })
    )
    expect(result.kind).toBe('commit')
    expect(result.disabled).toBe(true)
    expect(result.title).toBe('Enter a commit message to commit')
  })

  it('returns Stage Files when unstaged changes exist on an in-sync branch', () => {
    const result = resolvePrimaryAction(
      inputs({ hasUnstagedChanges: true, upstreamStatus: upstreamInSync })
    )
    expect(result).toEqual({
      kind: 'stage',
      label: 'Stage Files',
      title: 'Stage all changes',
      disabled: false
    })
  })

  it('returns a disabled Commit when clean and upstream status not yet resolved', () => {
    const result = resolvePrimaryAction(inputs())
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Stage at least one file to commit',
      disabled: true
    })
  })

  it('returns Create PR when a clean tracked branch is eligible for review creation', () => {
    const result = resolvePrimaryAction(
      inputs({
        upstreamStatus: upstreamInSync,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    )
    expect(result).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Create a pull request for this branch',
      disabled: false
    })
  })
})

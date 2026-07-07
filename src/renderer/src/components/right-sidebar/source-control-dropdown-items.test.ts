import { describe, expect, it } from 'vitest'
import { resolveDropdownItems, type DropdownActionInputs } from './source-control-dropdown-items'

// Why: a shared defaults object keeps each case row terse while making the
// "this is the one knob that differs from the baseline" intent obvious.
function inputs(overrides: Partial<DropdownActionInputs> = {}): DropdownActionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: undefined,
    ...overrides
  }
}

describe('resolveDropdownItems', () => {
  it('renders every row — Commit through Publish — for a staged, tracked, ahead+behind branch', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 }
      })
    )
    const kinds = items.map((item) => item.kind)
    expect(kinds).toEqual([
      'commit',
      'commit_push',
      'commit_sync',
      'separator',
      'push',
      'force_push',
      'create_pr',
      'push_create_pr',
      'pull',
      'fast_forward',
      'sync',
      'rebase_base',
      'fetch',
      'publish'
    ])
  })

  it('disables compound commit actions when no staged files', () => {
    const items = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 } })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.commit.disabled).toBe(true)
    expect(byKind.commit_push.disabled).toBe(true)
    expect(byKind.commit_sync.disabled).toBe(true)
  })

  it('enables commit actions when staged files also have unstaged changes', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasUnstagedChanges: true,
        hasPartiallyStagedChanges: true,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.commit.disabled).toBe(false)
    expect(byKind.commit_push.disabled).toBe(false)
    expect(byKind.commit_sync.disabled).toBe(false)
    expect(byKind.commit.title).toBe('Commit staged changes')
  })

  it('disables push actions but keeps Fetch enabled when branch has no upstream', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.disabled).toBe(true)
    expect(byKind.commit_push.disabled).toBe(true)
    expect(byKind.publish.disabled).toBe(false)
    expect(byKind.fetch.disabled).toBe(false)
  })

  it('does not offer Publish Branch when HEAD is detached', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 4,
        hasCurrentBranch: false
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.title).toBe('Check out a branch before pushing commits')
    expect(byKind.publish.label).toBe('No Branch')
    expect(byKind.publish.title).toBe('Check out a branch before publishing commits')
    expect(byKind.publish.disabled).toBe(true)
  })

  it('disables Publish Branch when branch already has an upstream', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.publish.disabled).toBe(true)
  })

  it('renders counts on action labels when > 0', () => {
    const items = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 3, behind: 2 } })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.label).toBe('Push (3)')
    expect(byKind.force_push.label).toBe('Force Push (3)')
    expect(byKind.pull.label).toBe('Pull (2)')
    expect(byKind.sync.label).toBe('Sync (↓2 ↑3)')
  })

  it('keeps push-only actions clickable on diverged branches', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(byKind.push.disabled).toBe(false)
    expect(byKind.push.title).toBe('Push local commits; git may require syncing first')
    expect(byKind.commit_push.disabled).toBe(false)
    expect(byKind.commit_push.title).toBe('Commit staged changes and try to push')
    expect(byKind.sync.disabled).toBe(false)
    expect(byKind.commit_sync.disabled).toBe(false)
  })

  it('offers force-push-with-lease when remote-only commits are patch-equivalent', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        branchCommitsAhead: 4,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 14,
          behind: 3,
          behindCommitsArePatchEquivalent: true
        },
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_sync',
          nextAction: 'sync'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(byKind.push.label).toBe('Push (14)')
    expect(byKind.push.disabled).toBe(true)
    expect(byKind.push.title).toBe('Use Force Push — remote only has older copies of local commits')
    expect(byKind.force_push.label).toBe('Force Push (4)')
    expect(byKind.force_push.disabled).toBe(false)
    expect(byKind.force_push.title).toBe(
      'Remote only has older copies of local commits. Force push 4 branch commits with lease to update origin/feature.'
    )
    expect(byKind.commit_push.label).toBe('Commit & Force Push')
    expect(byKind.commit_push.disabled).toBe(false)
    expect(byKind.commit_push.title).toBe('Commit staged changes and force push with lease')
    expect(byKind.pull.disabled).toBe(false)
    expect(byKind.pull.title).toBe(
      'Nothing new to pull — remote only has older copies of local commits'
    )
    expect(byKind.fast_forward.disabled).toBe(false)
    expect(byKind.fast_forward.title).toBe(
      'Nothing new to fast-forward — remote only has older copies of local commits'
    )
    expect(byKind.commit_sync.label).toBe('Commit & Sync')
    expect(byKind.commit_sync.disabled).toBe(true)
    expect(byKind.commit_sync.title).toBe(
      'Use Commit & Force Push — remote only has older copies of local commits'
    )
    expect(byKind.sync.disabled).toBe(true)
    expect(byKind.sync.title).toBe('Use Force Push — remote only has older copies of local commits')
    expect(byKind.create_pr.hint).toBe('Force Push first')
    expect(byKind.push_create_pr.label).toBe('Force Push before PR')
    expect(byKind.push_create_pr.disabled).toBe(false)
  })

  it('offers explicit force-push-with-lease for an ordinary ahead branch', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 1,
          behind: 0
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(byKind.push.label).toBe('Push (1)')
    expect(byKind.push.disabled).toBe(false)
    expect(byKind.force_push.label).toBe('Force Push (1)')
    expect(byKind.force_push.disabled).toBe(false)
    expect(byKind.force_push.title).toBe(
      'Force push 1 local commit with lease to update origin/feature.'
    )
  })

  it('omits counts from labels when ahead/behind are 0', () => {
    const items = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 } })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.label).toBe('Push')
    expect(byKind.force_push.label).toBe('Force Push')
    expect(byKind.pull.label).toBe('Pull')
    expect(byKind.sync.label).toBe('Sync')
    expect(byKind.push.disabled).toBe(false)
    expect(byKind.force_push.disabled).toBe(false)
    expect(byKind.pull.disabled).toBe(false)
    expect(byKind.fast_forward.disabled).toBe(false)
    expect(byKind.sync.disabled).toBe(false)
  })

  it('locks every item while a remote op is running', () => {
    const items = resolveDropdownItems(
      inputs({
        isRemoteOperationActive: true,
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 }
      })
    )
    for (const entry of items) {
      if (entry.kind !== 'separator') {
        expect(entry.disabled).toBe(true)
      }
    }
  })

  it('shows a destructive abort item only while merge or rebase is in progress', () => {
    const mergeItems = resolveDropdownItems(
      inputs({
        conflictOperation: 'merge',
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    const rebaseItems = resolveDropdownItems(
      inputs({
        conflictOperation: 'rebase',
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    const mergeByKind = Object.fromEntries(
      mergeItems.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    const rebaseByKind = Object.fromEntries(
      rebaseItems.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(mergeByKind.abort_merge).toMatchObject({
      label: 'Abort merge',
      title: 'Abort the merge in progress',
      disabled: false,
      variant: 'destructive'
    })
    expect(rebaseByKind.abort_rebase).toMatchObject({
      label: 'Abort rebase',
      title: 'Abort the rebase in progress',
      disabled: false,
      variant: 'destructive'
    })
    expect(mergeByKind.abort_rebase).toBeUndefined()
    expect(rebaseByKind.abort_merge).toBeUndefined()

    for (const conflictOperation of ['unknown', 'cherry-pick'] as const) {
      const items = resolveDropdownItems(inputs({ conflictOperation }))
      expect(items.some((entry) => entry.kind === 'abort_merge')).toBe(false)
      expect(items.some((entry) => entry.kind === 'abort_rebase')).toBe(false)
    }
  })

  it('disables conflict abort actions while another action is busy', () => {
    const items = resolveDropdownItems(
      inputs({
        conflictOperation: 'merge',
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    const rebaseItems = resolveDropdownItems(
      inputs({
        conflictOperation: 'rebase',
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    )
    const abortMerge = items.find((entry) => entry.kind === 'abort_merge')
    const abortRebase = rebaseItems.find((entry) => entry.kind === 'abort_rebase')

    expect(abortMerge).toMatchObject({
      disabled: true,
      title: 'Operation in progress…'
    })
    expect(abortRebase).toMatchObject({
      disabled: true,
      title: 'Operation in progress…'
    })
  })

  it('locks every item while a hosted review operation is running', () => {
    const items = resolveDropdownItems(
      inputs({
        isPullRequestOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    )

    for (const entry of items) {
      if (entry.kind !== 'separator') {
        expect(entry.disabled).toBe(true)
        expect(entry.title).toBe('Hosted review operation in progress…')
      }
    }
  })

  it('disables remote rows with a loading tooltip when upstreamStatus is undefined', () => {
    // Why: mirrors the primary-action guard — while fetchUpstreamStatus is in
    // flight we must not let the user click Publish on an already-tracked
    // branch (which would re-run `git push -u` and clobber the upstream).
    const items = resolveDropdownItems(
      inputs({ stagedCount: 1, hasMessage: true, upstreamStatus: undefined })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    const loadingBlocked = [
      'commit_push',
      'commit_sync',
      'push',
      'force_push',
      'pull',
      'fast_forward',
      'sync',
      'publish'
    ] as const
    for (const kind of loadingBlocked) {
      expect(byKind[kind].disabled).toBe(true)
      expect(byKind[kind].title).toBe('Checking branch status…')
    }
    // Commit itself does not depend on upstream — it remains enabled when
    // staged + message are present and no commit is in flight.
    expect(byKind.commit.disabled).toBe(false)
    expect(byKind.fetch.disabled).toBe(false)
    expect(byKind.fetch.title).toBe('Fetch from remote without merging')
  })

  it('keeps Fetch enabled and surfaces publish-first tooltips when upstream is absent', () => {
    // Why: sibling to the upstreamStatus=undefined test above. Once the fetch
    // resolves to hasUpstream=false, the dropdown should explain that the
    // user needs to publish first (rather than leaving the loading copy).
    const items = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.title).toBe('Publish the branch first to push commits')
    expect(byKind.pull.title).toBe('Publish the branch first to pull commits')
    expect(byKind.fast_forward.title).toBe('Publish the branch first to fast-forward')
    expect(byKind.sync.title).toBe('Publish the branch first to sync commits')
    expect(byKind.fetch.title).toBe('Fetch from remote without merging')
    expect(byKind.fetch.disabled).toBe(false)
    expect(byKind.publish.title).toBe('Publish this branch to origin')
    expect(byKind.publish.disabled).toBe(false)
  })

  it('enables rebase from base only on a clean tree with a remote base ref', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        rebaseBaseRef: 'origin/main'
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(byKind.rebase_base.label).toBe('Rebase from origin/main')
    expect(byKind.rebase_base.title).toBe(
      'Rebase current branch with latest commits from origin/main'
    )
    expect(byKind.rebase_base.disabled).toBe(false)
  })

  it('keeps rebase from base clickable while local changes are present', () => {
    const items = resolveDropdownItems(
      inputs({
        hasUnstagedChanges: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        rebaseBaseRef: 'origin/main'
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(byKind.rebase_base.disabled).toBe(false)
    expect(byKind.rebase_base.title).toBe(
      'Try rebasing; git may require committing or stashing local changes first'
    )
  })

  it('shows Publish Branch when an unpublished branch has no commits ahead', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 0
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.publish.label).toBe('Publish Branch')
    expect(byKind.publish.title).toBe('Publish this branch to origin')
    expect(byKind.publish.disabled).toBe(false)
  })

  it('keeps Publish Branch available for an unpublished dirty branch with no commits', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 0
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.publish.label).toBe('Publish Branch')
    expect(byKind.publish.title).toBe('Publish this branch to origin')
    expect(byKind.publish.disabled).toBe(false)
  })

  it('does not mention Publish Branch when the linked PR is already merged', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        prState: 'merged'
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.title).toBe('PR is already merged')
    expect(byKind.pull.title).toBe('PR is already merged')
    expect(byKind.fast_forward.title).toBe('PR is already merged')
    expect(byKind.sync.title).toBe('PR is already merged')
    expect(byKind.publish.label).toBe('PR Status')
    expect(byKind.publish.title).toBe('PR is already merged')
    expect(byKind.publish.disabled).toBe(true)
  })

  it('offers Push instead of Publish Branch when an open linked review has no upstream', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 1,
        prState: 'open',
        canPushLinkedReviewWithoutUpstream: true
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.commit_push.disabled).toBe(false)
    expect(byKind.push.title).toBe('Push updates to the linked review branch')
    expect(byKind.push.disabled).toBe(false)
    expect(byKind.publish.label).toBe('Linked Review')
    expect(byKind.publish.title).toBe('Linked review branch already exists')
    expect(byKind.publish.disabled).toBe(true)
  })

  it('blocks Push when an open linked review has no upstream and no branch target', () => {
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 1,
        prState: 'open'
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.commit_push.disabled).toBe(true)
    expect(byKind.commit_push.title).toBe('Linked review branch target is unavailable')
    expect(byKind.push.title).toBe('Linked review branch target is unavailable')
    expect(byKind.push.disabled).toBe(true)
    expect(byKind.publish.label).toBe('Linked Review')
    expect(byKind.publish.title).toBe('Linked review branch target is unavailable')
    expect(byKind.publish.disabled).toBe(true)
  })

  it('waits for linked PR state before showing a publish prompt', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        isPRStateLoading: true
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.publish.label).toBe('PR Status')
    expect(byKind.publish.title).toBe('Checking PR status…')
    expect(byKind.publish.disabled).toBe(true)
  })

  it('omits counts from compound commit labels even when ahead/behind are nonzero', () => {
    // Why: the commit itself changes ahead/behind, so pre-commit counts would
    // be stale the moment the action fires. Plain Push/Pull/Sync continue to
    // carry counts because no commit is interposed.
    const items = resolveDropdownItems(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.commit_push.label).toBe('Commit & Push')
    expect(byKind.commit_sync.label).toBe('Commit & Sync')
    // Sanity check: plain counterparts still carry counts.
    expect(byKind.push.label).toBe('Push (2)')
    expect(byKind.sync.label).toBe('Sync (↓3 ↑2)')
  })

  it('keeps fast-forward clickable even when git may reject the branch shape', () => {
    const behindOnly = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 2 } })
    )
    const diverged = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 1, behind: 2 } })
    )
    const behindOnlyByKind = Object.fromEntries(
      behindOnly.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    const divergedByKind = Object.fromEntries(
      diverged.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )

    expect(behindOnlyByKind.fast_forward.label).toBe('Fast-forward (2)')
    expect(behindOnlyByKind.fast_forward.title).toBe('Fast-forward 2 commits')
    expect(behindOnlyByKind.fast_forward.disabled).toBe(false)
    expect(divergedByKind.fast_forward.disabled).toBe(false)
    expect(divergedByKind.fast_forward.title).toBe(
      'Try a fast-forward pull; git may reject local commits'
    )
  })

  it('enables the push-before-PR recovery action when review creation is only blocked by unpushed commits', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.create_pr.disabled).toBe(false)
    expect(byKind.create_pr.hint).toBe('Push first')
    expect(byKind.push_create_pr.label).toBe('Push before PR')
    expect(byKind.push_create_pr.disabled).toBe(false)
  })

  it('uses GitLab MR copy for create and push-before-create rows', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.create_pr.label).toBe('Create MR')
    expect(byKind.create_pr.hint).toBe('Push first')
    expect(byKind.create_pr.disabled).toBe(false)
    expect(byKind.push_create_pr.label).toBe('Push before MR')
    expect(byKind.push_create_pr.title).toBe('Push local commits before creating a merge request')
    expect(byKind.push_create_pr.disabled).toBe(false)
  })

  it.each(['azure-devops', 'gitea'] as const)(
    'enables push-before-PR recovery for %s review creation',
    (provider) => {
      const items = resolveDropdownItems(
        inputs({
          upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
          hostedReviewCreation: {
            provider,
            review: null,
            canCreate: false,
            blockedReason: 'needs_push',
            nextAction: 'push'
          }
        })
      )
      const byKind = Object.fromEntries(
        items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
      )
      expect(byKind.create_pr.label).toBe('Create PR')
      expect(byKind.create_pr.hint).toBe('Push first')
      expect(byKind.create_pr.disabled).toBe(false)
      expect(byKind.push_create_pr.label).toBe('Push before PR')
      expect(byKind.push_create_pr.title).toBe('Push local commits before creating a pull request')
      expect(byKind.push_create_pr.disabled).toBe(false)
    }
  )

  it.each([
    ['azure-devops', 'Set ORCA_AZURE_DEVOPS_TOKEN in this environment'],
    ['gitea', 'Set ORCA_GITEA_TOKEN in this environment']
  ] as const)('uses token auth copy when %s PR creation needs authentication', (provider, hint) => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          provider,
          review: null,
          canCreate: false,
          blockedReason: 'auth_required',
          nextAction: 'authenticate'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.create_pr.hint).toBe(hint)
  })

  it('uses GitLab auth copy when MR creation needs authentication', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 },
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: 'auth_required',
          nextAction: 'authenticate'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.create_pr.hint).toBe('Run glab auth login in this environment')
  })
})

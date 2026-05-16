import { describe, expect, it } from 'vitest'
import { resolveDropdownItems } from './source-control-dropdown-items'
import type { PrimaryActionInputs } from './source-control-primary-action'

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
      'create_pr',
      'push_create_pr',
      'pull',
      'sync',
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
    expect(byKind.pull.label).toBe('Pull (2)')
    expect(byKind.sync.label).toBe('Sync (↓2 ↑3)')
  })

  it('omits counts from labels when ahead/behind are 0', () => {
    const items = resolveDropdownItems(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 } })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.push.label).toBe('Push')
    expect(byKind.pull.label).toBe('Pull')
    expect(byKind.sync.label).toBe('Sync')
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
      'pull',
      'sync',
      'fetch',
      'publish'
    ] as const
    for (const kind of loadingBlocked) {
      expect(byKind[kind].disabled).toBe(true)
      expect(byKind[kind].title).toBe('Checking branch status…')
    }
    // Commit itself does not depend on upstream — it remains enabled when
    // staged + message are present and no commit is in flight.
    expect(byKind.commit.disabled).toBe(false)
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
    expect(byKind.sync.title).toBe('Publish the branch first to sync commits')
    expect(byKind.fetch.title).toBe('Fetch from remote without merging')
    expect(byKind.fetch.disabled).toBe(false)
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
    expect(byKind.sync.title).toBe('PR is already merged')
    expect(byKind.publish.label).toBe('PR Status')
    expect(byKind.publish.title).toBe('PR is already merged')
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

  it('enables Push & Create PR when review creation is only blocked by unpushed commits', () => {
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
    expect(byKind.create_pr.disabled).toBe(true)
    expect(byKind.create_pr.hint).toBe('Push first')
    expect(byKind.push_create_pr.disabled).toBe(false)
  })
})

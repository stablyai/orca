import { describe, expect, it } from 'vitest'
import type { DropdownActionInputs } from './source-control-dropdown-item-types'
import { deriveDropdownActionContext } from './source-control-dropdown-action-context'
import { buildRemoteDropdownItems } from './source-control-dropdown-remote-items'
import { buildCommitDropdownItems } from './source-control-dropdown-commit-items'

function inputs(overrides: Partial<DropdownActionInputs>): DropdownActionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 0 },
    hasCurrentBranch: true,
    rebaseBaseRef: 'origin/main',
    ...overrides
  }
}

function build(overrides: Partial<DropdownActionInputs>) {
  const ctx = deriveDropdownActionContext(inputs(overrides))
  return { ...buildRemoteDropdownItems(ctx), ...buildCommitDropdownItems(ctx) }
}

describe('dropdown row status', () => {
  it('moves counts out of labels and keeps idle rows clickable', () => {
    const upToDate = build({})
    // pushRemote can target a fork that tracked-upstream counts do not describe.
    expect(upToDate.push).toMatchObject({ label: 'Push', status: 'Up to date', disabled: false })
    expect(upToDate.forcePush).toMatchObject({ status: 'Up to date', disabled: false })
    // Counts can be stale until a fetch, so fetching actions stay clickable.
    expect(upToDate.pull).toMatchObject({ status: 'Up to date', idle: true, disabled: false })
    expect(upToDate.sync).toMatchObject({ status: 'Up to date', idle: true, disabled: false })

    const diverged = build({
      upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 1, behind: 3 }
    })
    expect(diverged.push).toMatchObject({ label: 'Push', status: '↑1', disabled: false })
    expect(diverged.forcePush).toMatchObject({ status: 'Replaces ↓3', statusTone: 'warning' })
    expect(diverged.pull).toMatchObject({ label: 'Pull', status: '↓3' })
    expect(diverged.fastForward.status).toBe('May fail')
    expect(diverged.sync).toMatchObject({ label: 'Sync', status: '↓3 ↑1' })
  })

  it('lets force push roll back remote-only commits when nothing is ahead', () => {
    const items = build({
      upstreamStatus: { hasUpstream: true, upstreamName: 'origin/feature', ahead: 0, behind: 2 }
    })
    expect(items.forcePush).toMatchObject({
      status: 'Replaces ↓2',
      statusTone: 'warning',
      disabled: false
    })
    expect(items.push.disabled).toBe(false)
  })

  it('explains unpublished branches with staged files', () => {
    const items = build({
      stagedCount: 2,
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    })
    expect(items.commit.status).toBe('Needs message')
    expect(items.commitPush.status).toBe('Not published')
    expect(items.push.status).toBe('Sets upstream')
    expect(items.pull).toMatchObject({ status: 'Not published', disabled: true })
    expect(items.rebase.status).toBe('Stash first')
  })

  it('reports detached HEAD as no branch', () => {
    const items = build({
      hasCurrentBranch: false,
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    })
    expect(items.commit.status).toBe('Nothing staged')
    expect(items.commitSync.status).toBe('No branch')
    expect(items.push).toMatchObject({ status: 'No branch', disabled: true })
    expect(items.sync.status).toBe('No branch')
  })
})

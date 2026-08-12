import { describe, expect, it } from 'vitest'
import {
  resolveDropdownItems,
  type DropdownActionInputs,
  type DropdownItem
} from './source-control-dropdown-items'

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

describe('resolveDropdownItems Create PR intent', () => {
  it('enables the push-before-PR recovery action when review creation is only blocked by unpushed commits', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push',
          reviewLookupOutcome: 'not_found'
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

  it.each([
    {
      name: 'push',
      provider: 'github' as const,
      upstreamStatus: { hasUpstream: true as const, ahead: 2, behind: 0 },
      blockedReason: 'needs_push' as const,
      expectedTitle: 'Push local commits before creating a pull request'
    },
    {
      name: 'force push',
      provider: 'gitlab' as const,
      upstreamStatus: {
        hasUpstream: true as const,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 1,
        behindCommitsArePatchEquivalent: true
      },
      blockedReason: 'needs_sync' as const,
      expectedTitle: 'Force push with lease before creating a merge request'
    }
  ])(
    'keeps $name-before-review recovery available when review lookup is unavailable',
    ({ provider, upstreamStatus, blockedReason, expectedTitle }) => {
      const items = resolveDropdownItems(
        inputs({
          branchCommitsAhead: 2,
          upstreamStatus,
          hostedReviewCreation: {
            provider,
            review: null,
            canCreate: false,
            blockedReason,
            nextAction: blockedReason === 'needs_push' ? 'push' : 'sync',
            reviewLookupOutcome: 'unavailable'
          }
        })
      )
      const pushCreate = items.find((item): item is DropdownItem => item.kind === 'push_create_pr')

      expect(pushCreate?.disabled).toBe(false)
      expect(pushCreate?.title).toBe(expectedTitle)
      expect(pushCreate?.hint).toBeUndefined()
    }
  )

  it('uses GitLab MR copy for create and push-before-create rows', () => {
    const items = resolveDropdownItems(
      inputs({
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push',
          reviewLookupOutcome: 'not_found'
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
            nextAction: 'push',
            reviewLookupOutcome: 'not_found'
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
          nextAction: 'authenticate',
          reviewLookupOutcome: 'not_found'
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
          nextAction: 'authenticate',
          reviewLookupOutcome: 'not_found'
        }
      })
    )
    const byKind = Object.fromEntries(
      items.filter((e) => e.kind !== 'separator').map((e) => [e.kind, e])
    )
    expect(byKind.create_pr.hint).toBe('Run glab auth login in this environment')
  })
})

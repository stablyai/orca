import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { EMPTY_PENDING_VM_CHECKOUT_INDEX } from '../../../../shared/pending-vm-checkouts'
import { withOrcaCloudHosts } from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import {
  parseOrcaCloudHostScopeKey,
  selectOrcaCloudHostScopeKey,
  withoutHiddenHostRepos
} from './use-sidebar-hidden-checkouts'

const environments = [
  { id: 'a', name: 'push-test sandbox 1a2b3c4d', source: 'ephemeral-vm' },
  { id: 'b', name: 'push-test sandbox 5e6f7a8b', source: 'ephemeral-vm' },
  { id: 'unfiled', name: 'push-test sandbox 9c0d1e2f', source: 'ephemeral-vm' },
  { id: 'vm', name: 'my recipe VM', source: 'ephemeral-vm' },
  { id: 'manual', name: 'push-test sandbox 1a2b3c4d', source: 'manual' }
]
// Sandbox a is team one's, b is team two's; `unfiled` has no team recorded yet.
const owners = { a: 'org:team-one', b: 'org:team-two' }

function scopeFor(activeOrgId: string | undefined) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these fields.
  const state = {
    runtimeEnvironments: environments,
    cloudAccountIdByEnvironmentId: owners,
    orcaProfileAuthStatus: { cloud: { userId: 'u1', ...(activeOrgId ? { activeOrgId } : {}) } }
  } as unknown as Pick<AppState, 'runtimeEnvironments'>
  const { primaryHostIds, hiddenHostIds } = parseOrcaCloudHostScopeKey(
    selectOrcaCloudHostScopeKey(state)
  )
  return { primary: [...primaryHostIds], hidden: [...hiddenHostIds] }
}

describe('Orca Cloud host scope', () => {
  it("lists the active team's sandboxes and hides the other team's and unfiled ones", () => {
    expect(scopeFor('team-one')).toEqual({
      primary: ['runtime:a'],
      hidden: ['runtime:b', 'runtime:unfiled']
    })
  })

  it('flips with a team switch', () => {
    expect(scopeFor('team-two')).toEqual({
      primary: ['runtime:b'],
      hidden: ['runtime:a', 'runtime:unfiled']
    })
  })

  it('hides every sandbox when signed out of Orca Cloud', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these fields.
    const signedOut = {
      runtimeEnvironments: environments,
      cloudAccountIdByEnvironmentId: owners,
      orcaProfileAuthStatus: null
    } as unknown as Pick<AppState, 'runtimeEnvironments'>
    expect(
      parseOrcaCloudHostScopeKey(selectOrcaCloudHostScopeKey(signedOut)).primaryHostIds.size
    ).toBe(0)
  })

  it("drops another team's sandbox project so it never gets its own header", () => {
    const local = { id: 'r', executionHostId: 'local' as const }
    const mine = { id: 'r', executionHostId: 'runtime:a' as const }
    const theirs = { id: 'otter', executionHostId: 'runtime:b' as const }
    const scope = withOrcaCloudHosts(EMPTY_PENDING_VM_CHECKOUT_INDEX, {
      primaryHostIds: new Set(['runtime:a']),
      hiddenHostIds: new Set(['runtime:b'])
    })
    expect(withoutHiddenHostRepos([local, mine, theirs], scope)).toEqual([local, mine])
  })
})

describe('a paired-from-birth cloud workspace (PAIRED-NO-ROW)', () => {
  it('keeps its sidebar row: its paired server is neither hidden nor primary-scoped', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these fields.
    const state = {
      runtimeEnvironments: [
        ...environments,
        { id: 'gh', name: 'orca-sandbox-push-test (cloud)', orcaCloudPaired: true }
      ],
      cloudAccountIdByEnvironmentId: owners,
      orcaProfileAuthStatus: { cloud: { userId: 'u1', activeOrgId: 'team-one' } }
    } as unknown as Pick<AppState, 'runtimeEnvironments'>
    const hosts = parseOrcaCloudHostScopeKey(selectOrcaCloudHostScopeKey(state))
    expect(hosts.hiddenHostIds.has('runtime:gh')).toBe(false)
    expect(hosts.primaryHostIds.has('runtime:gh')).toBe(false)
    // EP-6: paired-scoped, so its base clone hides only beside a linked worktree.
    expect(hosts.pairedHostIds.has('runtime:gh')).toBe(true)
    // The owned sandboxes are still scoped by team exactly as before.
    expect([...hosts.hiddenHostIds]).toEqual(['runtime:b', 'runtime:unfiled'])
    // Its project survives the sidebar's repo scoping.
    const repo = { id: 'gh-repo', executionHostId: 'runtime:gh' as const }
    expect(
      withoutHiddenHostRepos([repo], withOrcaCloudHosts(EMPTY_PENDING_VM_CHECKOUT_INDEX, hosts))
    ).toEqual([repo])
  })
})

describe('paired workspaces scoped by account (PAIRED-ACCOUNT-FILTER)', () => {
  const paired = (accountId?: string) => ({
    id: 'gh',
    name: 'orca-sandbox-push-test (cloud)',
    orcaCloudPaired: true,
    ...(accountId ? { orcaCloudPairedAccountId: accountId } : {})
  })
  function hostsFor(activeOrgId: string, environment: ReturnType<typeof paired>) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these fields.
    const state = {
      runtimeEnvironments: [environment],
      cloudAccountIdByEnvironmentId: {},
      orcaProfileAuthStatus: { cloud: { userId: 'u1', activeOrgId } }
    } as unknown as Pick<AppState, 'runtimeEnvironments'>
    return parseOrcaCloudHostScopeKey(selectOrcaCloudHostScopeKey(state))
  }

  it("the active team's paired-from-birth row stays visible, never primary-scoped (no PAIRED-NO-ROW)", () => {
    const hosts = hostsFor('team-one', paired('org:team-one'))
    expect(hosts.hiddenHostIds.has('runtime:gh')).toBe(false)
    expect(hosts.primaryHostIds.has('runtime:gh')).toBe(false)
    expect(hosts.pairedHostIds.has('runtime:gh')).toBe(true)
  })

  it("after a team switch, the other team's paired workspace is hidden like its owned rows", () => {
    expect(hostsFor('team-two', paired('org:team-one')).hiddenHostIds.has('runtime:gh')).toBe(true)
  })

  it('a pairing saved before it was stamped stays visible until the prune stamps it', () => {
    expect(hostsFor('team-two', paired()).hiddenHostIds.has('runtime:gh')).toBe(false)
  })
})

describe('GH-CREATE-NO-ROW hand-off', () => {
  it('hides the server a GitHub-only create is pairing to until its pending row hands off', () => {
    const pairing = (pairingHostId?: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these fields.
      ({
        runtimeEnvironments: [{ id: 'p', name: 'web (cloud)', orcaCloudPaired: true }],
        orcaProfileAuthStatus: { cloud: { userId: 'u1' } },
        pendingWorktreeCreations: {
          gh: {
            creationId: 'gh',
            request: { githubSource: { fullName: 'acme/web' } },
            ...(pairingHostId ? { pairingHostId } : {})
          }
        }
      }) as unknown as Pick<AppState, 'runtimeEnvironments'>
    const hidden = (state: Pick<AppState, 'runtimeEnvironments'>) => [
      ...parseOrcaCloudHostScopeKey(selectOrcaCloudHostScopeKey(state)).hiddenHostIds
    ]
    expect(hidden(pairing())).toEqual([])
    expect(hidden(pairing('runtime:p'))).toEqual(['runtime:p'])
  })
})

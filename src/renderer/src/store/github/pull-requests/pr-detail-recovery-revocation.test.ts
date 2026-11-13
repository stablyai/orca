import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { PRDetailRecoverySnapshot } from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { getGitHubRepoCacheKey } from '../../../../../shared/github/cache/github-cache-key'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi
} from '../github-slice-test-harness'
import { capturePRDetailRecoveryAuthority } from './pr-detail-recovery-authority'
import { resolvePRDetailRecoveryTransport } from './pr-detail-recovery-transport'

vi.mock('./pr-detail-recovery-transport', () => ({ resolvePRDetailRecoveryTransport: vi.fn() }))

const context = {
  worktreeId: 'wt-1',
  repoId: 'repo-1',
  repoPath: '/repo',
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  branch: 'feature/test',
  headOid: 'h2',
  linkedPRNumber: null,
  hintPRNumber: 7,
  hostedReviewCacheKey: 'hosted::/repo::feature/test',
  selectionRevision: '|||||'
}
let statusChanged: (snapshot: RuntimeHostStatusSnapshot) => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  Object.assign(mockApi.runtimeEnvironments, {
    onStatusChanged: (listener: typeof statusChanged) => {
      statusChanged = listener
      return () => {}
    }
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['before delivery', 'after delivery'] as const)(
  'revocation %s fences the grant without retracting an already published PR',
  async (stage) => {
    const store = createTestStore()
    store.getState().notePRDetailRecoveryPanelVisible(false)
    store.setState({
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }],
      worktreesByRepo: {
        'repo-1': [makePRRefreshWorktree({ id: 'wt-1', branch: 'feature/test', head: 'h2' })]
      }
    })
    const cacheKey = getGitHubRepoCacheKey(
      '/repo',
      'repo-1',
      'feature/test',
      store.getState().settings,
      undefined,
      undefined,
      true
    )
    const authority = capturePRDetailRecoveryAuthority('env-1', {
      supported: true,
      runtimeId: 'runtime-1',
      pairingRevision: 1
    })
    let snapshot!: PRDetailRecoverySnapshot
    let publicationGrantId = ''
    let release!: (snapshot: PRDetailRecoverySnapshot) => void
    let waiting!: () => void
    const enteredWait = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const heldOutcome = new Promise<PRDetailRecoverySnapshot>((resolve) => {
      release = resolve
    })
    vi.mocked(resolvePRDetailRecoveryTransport).mockResolvedValue({
      sourceEpoch: 'renderer:test',
      signal: authority.signal,
      dispose: authority.dispose,
      start: async (args) => {
        snapshot = {
          ticketId: 'ticket',
          hostInstance: 'host',
          identity: args.identity,
          revision: 2,
          acceptSequence: 1,
          predecessors: [],
          phase: 'preparing',
          admitted: false,
          preparation: { token: 'prepare', expiresAt: 1000 + 20_000, prepareSequence: 1 }
        }
        return snapshot
      },
      commit: async (args) => {
        publicationGrantId = args.publicationGrantId
        return snapshot
      },
      wait: async () => {
        waiting()
        return heldOutcome
      },
      cancel: async () => null
    })
    store.getState().notePRDetailRecoveryPanelVisible(true)
    store.getState().reconcileGitHubPRDetails(context)
    await enteredWait
    const revoke = (): void =>
      statusChanged({
        environmentId: 'env-1',
        pairingRevision: 1,
        sequence: 2,
        checkedAt: 1000,
        status: null,
        verification: 'blocked',
        blockedReason: 'access-revoked',
        transport: 'disconnected'
      })
    if (stage === 'before delivery') {
      revoke()
    }
    release({
      ...snapshot,
      revision: 4,
      phase: 'terminal',
      admitted: true,
      publicationGrantId,
      requestSequence: 1,
      requestStartedAt: 1000,
      preparation: undefined,
      terminal: {
        kind: 'settled',
        outcome: {
          kind: 'found',
          pr: makePR({ number: 8, headSha: 'h2' }),
          fetchedAt: 1000
        }
      }
    })
    await heldOutcome
    if (stage === 'after delivery') {
      await vi.waitFor(() => expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8))
      revoke()
      expect(store.getState().prCache[cacheKey]?.data?.number).toBe(8)
    } else {
      expect(store.getState().prCache[cacheKey]?.data).toBeUndefined()
      expect(store.getState().prDetailRecovery?.status).toEqual({ kind: 'closed' })
    }
    store.getState().notePRDetailRecoveryPanelVisible(false)
  }
)

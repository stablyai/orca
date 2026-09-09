import { describe, expect, it } from 'vitest'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import { hostSnapshotAffirmsClientHostedPages } from './host-session-snapshot-authority'

const REAL_EPOCH = 'headless:abc'

describe('reading whether a snapshot answers for client-hosted pages', () => {
  it('affirms a fully published snapshot carrying no unreconciled flag', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({ publicationEpoch: REAL_EPOCH, snapshotVersion: 3 })
    ).toBe(true)
  })

  // A runtime that just restarted republishes rehydrated terminals under a real epoch and version:
  // that frame is authoritative for what it owns, but not for browser rows its hosts still hold.
  it('does not affirm a restarted runtime that has not heard from its hosts yet', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({
        publicationEpoch: REAL_EPOCH,
        snapshotVersion: 3,
        clientHostedPagesUnreconciled: true
      })
    ).toBe(false)
  })

  // Inherited from the worktree-level gate: the placeholder pair is the runtime saying "ask later".
  it('does not affirm the unpublished-worktree placeholder frame', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({
        publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
        snapshotVersion: 0
      })
    ).toBe(false)
  })

  it('does not affirm when the placeholder frame also carries the unreconciled flag', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({
        publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
        snapshotVersion: 0,
        clientHostedPagesUnreconciled: true
      })
    ).toBe(false)
  })

  // Only the epoch+version pair marks a synthesized frame; each half alone is a legitimate state.
  it('affirms a real epoch at version zero', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({ publicationEpoch: REAL_EPOCH, snapshotVersion: 0 })
    ).toBe(true)
  })

  it('affirms the placeholder epoch once it carries a version', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({
        publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
        snapshotVersion: 1
      })
    ).toBe(true)
  })

  // Explicit `undefined` as well as an absent key: a host that omits the flag means reconciled.
  it('affirms when the unreconciled flag is absent or explicitly undefined', () => {
    expect(
      hostSnapshotAffirmsClientHostedPages({ publicationEpoch: REAL_EPOCH, snapshotVersion: 1 })
    ).toBe(true)
    expect(
      hostSnapshotAffirmsClientHostedPages({
        publicationEpoch: REAL_EPOCH,
        snapshotVersion: 1,
        clientHostedPagesUnreconciled: undefined
      })
    ).toBe(true)
  })
})

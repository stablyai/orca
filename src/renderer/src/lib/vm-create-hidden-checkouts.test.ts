import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SIDEBAR_FEED_DOMAINS } from '../../../shared/sidebar-feed-client/sidebar-feed-snapshot'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  hideVmCreateCheckout,
  readHiddenVmCheckouts,
  releaseVmCreateCheckout,
  settleVmCreateCheckoutAfterCleanup,
  withOrcaCloudPrimaryHosts,
  withoutHiddenVmCheckouts,
  withoutHiddenVmWorktrees,
  withoutHiddenVmWorktreesByRepo
} from './vm-create-hidden-checkouts'

type Row = { repoId: string; path: string; isMainWorktree?: boolean }

function domainsWith(workspaces: Row[], pairedServerRows: Row[]): SidebarFeedDomains {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the filter reads only repoId, path and isMainWorktree.
  return {
    ...EMPTY_SIDEBAR_FEED_DOMAINS,
    workspaces: new Map(workspaces.map((row, i) => [`w${i}`, row])),
    pairedServerRows: new Map(pairedServerRows.map((row, i) => [`p${i}`, row]))
  } as unknown as SidebarFeedDomains
}

function isListed(repoId: string, path = '/srv/repo'): boolean {
  return (
    withoutHiddenVmWorktrees([{ repoId, path, isMainWorktree: true }], readHiddenVmCheckouts())
      .length === 1
  )
}

afterEach(() => {
  releaseVmCreateCheckout('c1')
  releaseVmCreateCheckout('c2')
  vi.useRealTimers()
})

describe('withoutHiddenVmCheckouts', () => {
  it('drops only the VM primary checkout while its create is in progress', () => {
    const vmPrimary = { repoId: 'vm-repo', path: '/srv/repo', isMainWorktree: true }
    const vmLinked = { repoId: 'vm-repo', path: '/srv/repo-wt', isMainWorktree: false }
    const sameRepoIdElsewhere = { repoId: 'vm-repo', path: '/other', isMainWorktree: true }
    const local = { repoId: 'local', path: '/srv/repo', isMainWorktree: true }
    const domains = domainsWith([local], [vmPrimary, vmLinked, sameRepoIdElsewhere])

    hideVmCreateCheckout('c1', { repoId: 'vm-repo', path: '/srv/repo/' })
    const filtered = withoutHiddenVmCheckouts(domains, readHiddenVmCheckouts())

    expect([...filtered.pairedServerRows.values()]).toEqual([vmLinked, sameRepoIdElsewhere])
    expect(filtered.workspaces).toBe(domains.workspaces)
  })
})

describe('hidden VM checkout lifecycle', () => {
  it('shows a VM again when its cleanup failed, but not after it was cleaned up', () => {
    vi.useFakeTimers()
    hideVmCreateCheckout('c1', { repoId: 'failed-vm', path: '/srv/repo' })
    settleVmCreateCheckoutAfterCleanup('c1', false)
    expect(isListed('failed-vm')).toBe(true)

    hideVmCreateCheckout('c2', { repoId: 'cleaned-vm', path: '/srv/repo' })
    settleVmCreateCheckoutAfterCleanup('c2', true)
    // A cancel racing the create cleans up twice; the second, failing pass must not un-hide it.
    settleVmCreateCheckoutAfterCleanup('c2', false)
    expect(isListed('cleaned-vm')).toBe(false)
    vi.runAllTimers()
    expect(isListed('cleaned-vm')).toBe(true)
  })

  it("keeps a retry's checkout hidden while the previous attempt's cleanup settles", () => {
    vi.useFakeTimers()
    hideVmCreateCheckout('c1', { repoId: 'vm', path: '/srv/repo' })
    settleVmCreateCheckoutAfterCleanup('c1', true)
    // Same host and path again: the retry's hide outlives the old attempt's.
    hideVmCreateCheckout('c1', { repoId: 'vm', path: '/srv/repo' })
    vi.runAllTimers()
    expect(isListed('vm')).toBe(false)
    releaseVmCreateCheckout('c1')
    expect(isListed('vm')).toBe(true)
  })
})

describe('Orca Cloud sandbox primaries', () => {
  // Two cloud workspaces of one project: each sandbox lists its clone (master) as primary.
  const hostA = 'runtime:sandbox-a'
  const hostB = 'runtime:sandbox-b'
  const cloudHosts = new Set([hostA, hostB])
  const cloneA = {
    repoId: 'r',
    path: '/vercel/sandbox/project',
    isMainWorktree: true,
    hostId: hostA
  }
  const cloneB = { ...cloneA, hostId: hostB }
  const sockeye = { repoId: 'r', path: '/w/sockeye', isMainWorktree: false, hostId: hostA }
  const otter = { repoId: 'r', path: '/w/otter', isMainWorktree: false, hostId: hostB }
  const local = { repoId: 'r', path: '/Users/me/repo', isMainWorktree: true, hostId: 'local' }

  it('lists neither clone as a row, keeping the cloud workspaces and the local primary', () => {
    const hidden = withOrcaCloudPrimaryHosts(readHiddenVmCheckouts(), cloudHosts)
    const rows = [local, cloneA, cloneB, sockeye, otter]

    expect(withoutHiddenVmWorktrees(rows, hidden)).toEqual([local, sockeye, otter])
    expect(withoutHiddenVmWorktreesByRepo({ r: rows }, hidden)).toEqual({
      r: [local, sockeye, otter]
    })
  })

  it("reads a paired-server row's host from its host-qualified key", () => {
    const { hostId: _a, ...rowA } = cloneA
    const { hostId: _b, ...rowB } = cloneB
    const { hostId: _s, ...rowS } = sockeye
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the filter reads only repoId, path, isMainWorktree and the key.
    const domains = {
      ...EMPTY_SIDEBAR_FEED_DOMAINS,
      pairedServerRows: new Map([
        [composeWorktreeHostIdentity(hostA, 'r::/vercel/sandbox/project'), rowA],
        [composeWorktreeHostIdentity(hostB, 'r::/vercel/sandbox/project'), rowB],
        [composeWorktreeHostIdentity(hostA, 'r::/w/sockeye'), rowS]
      ])
    } as unknown as SidebarFeedDomains
    const hidden = withOrcaCloudPrimaryHosts(readHiddenVmCheckouts(), cloudHosts)

    expect([...withoutHiddenVmCheckouts(domains, hidden).pairedServerRows.values()]).toEqual([rowS])
  })

  it('leaves lists untouched when no Orca Cloud host is known', () => {
    const rows = [local, cloneA]
    const hidden = withOrcaCloudPrimaryHosts(readHiddenVmCheckouts(), new Set())
    expect(withoutHiddenVmWorktrees(rows, hidden)).toBe(rows)
  })
})

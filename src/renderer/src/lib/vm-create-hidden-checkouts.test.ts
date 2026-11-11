import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SIDEBAR_FEED_DOMAINS } from '../../../shared/sidebar-feed-client/sidebar-feed-snapshot'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  hideVmCreateCheckout,
  readHiddenVmCheckouts,
  releaseVmCreateCheckout,
  settleVmCreateCheckoutAfterCleanup,
  withOrcaCloudHosts,
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

describe('Orca Cloud sandboxes', () => {
  // Two cloud workspaces of one project: each sandbox lists its clone (master) as primary.
  const hostA = 'runtime:sandbox-a'
  const hostB = 'runtime:sandbox-b'
  const hostC = 'runtime:sandbox-c'
  const otherTeam = 'runtime:sandbox-other-team'
  const clone = (hostId: string) => ({
    repoId: 'r',
    path: '/vercel/sandbox/project',
    isMainWorktree: true,
    hostId
  })
  const sockeye = { repoId: 'r', path: '/w/sockeye', isMainWorktree: false, hostId: hostA }
  const otter = { repoId: 'r', path: '/w/otter', isMainWorktree: false, hostId: hostB }
  const local = { repoId: 'r', path: '/Users/me/repo', isMainWorktree: true, hostId: 'local' }
  const scoped = (hiddenHostIds: string[] = []) =>
    withOrcaCloudHosts(readHiddenVmCheckouts(), {
      primaryHostIds: new Set([hostA, hostB, hostC]),
      hiddenHostIds: new Set(hiddenHostIds)
    })

  it('lists one row per cloud workspace across two sandboxes and no clone rows', () => {
    const rows = [local, clone(hostA), clone(hostB), sockeye, otter]
    const listed = withoutHiddenVmWorktrees(rows, scoped())

    expect(listed).toEqual([local, sockeye, otter])
    expect(listed.filter((row) => row.hostId !== 'local' && row.isMainWorktree)).toEqual([])
    expect(withoutHiddenVmWorktreesByRepo({ r: rows }, scoped())).toEqual({
      r: [local, sockeye, otter]
    })
  })

  it("hides a sandbox's clone even when it is that sandbox's only row", () => {
    expect(withoutHiddenVmWorktrees([local, clone(hostC)], scoped())).toEqual([local])
  })

  it("leaves this computer's primary checkout alone", () => {
    const rows = [local]
    expect(withoutHiddenVmWorktrees(rows, scoped())).toBe(rows)
  })

  it("hides every row of another team's sandbox, and leaves local rows alone", () => {
    const foreign = { repoId: 'r', path: '/w/x', isMainWorktree: false, hostId: otherTeam }
    const rows = [local, clone(otherTeam), foreign, clone(hostA), sockeye]
    expect(withoutHiddenVmWorktrees(rows, scoped([otherTeam]))).toEqual([local, sockeye])
  })

  it("reads a paired-server row's host from its host-qualified key", () => {
    const strip = <T extends { hostId: string }>({ hostId: _hostId, ...row }: T) => row
    const rowS = strip(sockeye)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the filter reads only repoId, path, isMainWorktree and the keys.
    const domains = {
      ...EMPTY_SIDEBAR_FEED_DOMAINS,
      pairedServerRows: new Map([
        [composeWorktreeHostIdentity(hostA, 'r::/vercel/sandbox/project'), strip(clone(hostA))],
        [composeWorktreeHostIdentity(hostA, 'r::/w/sockeye'), rowS],
        [composeWorktreeHostIdentity(hostC, 'r::/vercel/sandbox/project'), strip(clone(hostC))],
        [composeWorktreeHostIdentity(otherTeam, 'r::/w/x'), rowS]
      ])
    } as unknown as SidebarFeedDomains
    const filtered = withoutHiddenVmCheckouts(domains, scoped([otherTeam]))

    expect([...filtered.pairedServerRows.values()]).toEqual([rowS])
  })

  it('leaves lists untouched when no Orca Cloud host is known', () => {
    const rows = [local, clone(hostA)]
    const none = withOrcaCloudHosts(readHiddenVmCheckouts(), {
      primaryHostIds: new Set(),
      hiddenHostIds: new Set()
    })
    expect(withoutHiddenVmWorktrees(rows, none)).toBe(rows)
  })
})

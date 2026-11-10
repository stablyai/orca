import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SIDEBAR_FEED_DOMAINS } from '../../../../shared/sidebar-feed-client/sidebar-feed-snapshot'
import type { SidebarFeedDomains } from '../../../../shared/sidebar-list/sidebar-feed-domains'
import {
  hideVmCreateCheckout,
  readHiddenVmCheckouts,
  releaseVmCreateCheckout,
  settleVmCreateCheckoutAfterCleanup,
  withoutHiddenVmCheckouts,
  withoutHiddenVmWorktrees
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

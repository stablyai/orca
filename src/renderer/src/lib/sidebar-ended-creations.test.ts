// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import type { DesktopSidebarFeed } from './desktop-sidebar-feed'

const feed = vi.hoisted(() => ({
  installListeners: new Set<(installed: DesktopSidebarFeed) => void>()
}))
vi.mock('./desktop-sidebar-feed', () => ({
  onDesktopSidebarFeedInstalled: (listener: (installed: DesktopSidebarFeed) => void) => {
    feed.installListeners.add(listener)
    return () => feed.installListeners.delete(listener)
  }
}))

function domainsWith(creations: SidebarFeedDomains['creations']): SidebarFeedDomains {
  return {
    workspaces: new Map(),
    activity: new Map(),
    review: new Map(),
    creations,
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
}

function install(domains: SidebarFeedDomains): void {
  feed.installListeners.forEach((listener) => listener({ domains, readId: 1 }))
}

async function load() {
  vi.resetModules()
  return {
    ended: await import('./sidebar-ended-creations'),
    model: await import('@/components/sidebar/worktree-list/listing/use-main-list-model')
  }
}

describe('ended window creations', () => {
  beforeEach(() => {
    feed.installListeners.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a creation the window just finished off the list while main’s feed still lists it', async () => {
    const { ended, model } = await load()
    // Main's last read predates its close, and names no workspace yet.
    const stale = domainsWith(new Map([['mine', { repoId: 'repo' }]]))
    const listed = () => [
      ...model.withWindowCreations(stale, [], ended.readEndedCreations()).creations.keys()
    ]
    expect(model.withWindowCreations(stale, ['mine repo'], new Set()).creations.has('mine')).toBe(
      true
    )
    ended.endWindowCreation('mine')
    expect(listed()).toEqual([])
    install(stale)
    expect(listed()).toEqual([])
    install(domainsWith(new Map()))
    expect(ended.readEndedCreations().size).toBe(0)
  })

  it('forgets an id main never lists after ten seconds', async () => {
    vi.useFakeTimers()
    const { ended } = await load()
    ended.endWindowCreation('preflight')
    vi.advanceTimersByTime(10_000)
    expect(ended.readEndedCreations().size).toBe(0)
  })
})

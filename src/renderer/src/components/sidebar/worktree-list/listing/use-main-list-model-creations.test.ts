// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { SidebarFeedDomains } from '../../../../../../shared/sidebar-list/sidebar-feed-domains'
import { withWindowCreations } from './use-main-list-model'

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

describe('withWindowCreations', () => {
  it('keeps every creation main lists, so a phone’s or the CLI’s shows as on the phone', () => {
    const domains = domainsWith(
      new Map([
        ['ran-here', { repoId: 'repo', worktreeId: 'wt' }],
        ['from-phone', { repoId: 'repo' }]
      ])
    )
    const listed = withWindowCreations(domains, ['ran-here repo', 'preflight repo'], new Set())
    expect([...listed.creations]).toEqual([
      ['ran-here', { repoId: 'repo', worktreeId: 'wt' }],
      ['from-phone', { repoId: 'repo' }],
      ['preflight', { repoId: 'repo' }]
    ])
  })

  it('keeps the same domains when the window adds no creation', () => {
    const domains = domainsWith(new Map([['from-phone', { repoId: 'repo' }]]))
    expect(withWindowCreations(domains, [], new Set())).toBe(domains)
  })
})

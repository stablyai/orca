import { describe, expect, it } from 'vitest'
import { cardHasCommanderActivity, projectCommanderAgents } from './commander-project-overview'

describe('Commander project overview', () => {
  it('groups 300 agent panes by canonical project across hosts and retains projects without agents', () => {
    const repos = [
      { id: 'api', displayName: 'API', upstream: { owner: 'acme', repo: 'api' } },
      {
        id: 'api-copy',
        displayName: 'API clone',
        executionHostId: 'runtime:build',
        upstream: { owner: 'acme', repo: 'api' }
      },
      { id: 'docs', displayName: 'Docs' }
    ] as const
    const cards = Array.from({ length: 300 }, (_, i) => ({
      paneKey: `pane-${i}`,
      repoId: i < 150 ? 'api' : 'api-copy',
      repoName: 'API',
      executionHostId: i < 150 ? ('local' as const) : ('runtime:build' as const),
      dotState: i % 3 === 0 ? ('blocked' as const) : ('working' as const),
      bucket: i % 3 === 0 ? ('attention' as const) : ('working' as const)
    }))
    const [api, docs] = projectCommanderAgents(repos, cards)
    expect(api).toMatchObject({ id: 'github:acme/api', blocked: 100, working: 200 })
    expect(api.cards).toHaveLength(300)
    expect(api.cards.findLast((card) => cardHasCommanderActivity(card, 'blocked'))?.paneKey).toBe(
      'pane-297'
    )
    expect(docs).toMatchObject({ id: 'repo:docs', cards: [], blocked: 0, working: 0 })
  })

  it('keeps unregistered host-local repository IDs separate from each other and registered projects', () => {
    const card = {
      repoId: 'api',
      repoName: 'API',
      dotState: 'blocked',
      bucket: 'attention'
    } as const
    const hosts = ['runtime:first', 'runtime:second', 'local'] as const
    const projects = projectCommanderAgents(
      [{ id: 'api', displayName: 'Local API' }],
      hosts.map((executionHostId) => ({ ...card, executionHostId }))
    )
    expect(projects).toHaveLength(3)
    expect(projects.every((row) => row.blocked === 1)).toBe(true)
    expect(projects.find((row) => row.id === 'repo:api')?.name).toBe('Local API')
  })
})

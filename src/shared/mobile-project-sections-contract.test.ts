import { describe, expect, it } from 'vitest'
import { buildMobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'

function repo(id: string, incognito?: boolean): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    ...(incognito !== undefined ? { incognito } : {})
  }
}

function project(id: string, sourceRepoIds: string[] = []): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 0,
    updatedAt: 0
  }
}

function setup(projectId: string, repoId: string): ProjectHostSetup {
  return {
    id: `${projectId}:${repoId}`,
    projectId,
    hostId: 'local',
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 0,
    updatedAt: 0
  }
}

describe('buildMobileProjectSectionCatalog', () => {
  it('never publishes an incognito repo, its setups, or a project only it names', () => {
    const catalog = buildMobileProjectSectionCatalog(
      [repo('open'), repo('secret', true), repo('mixed-secret', true), repo('mixed-open', false)],
      {
        projects: [project('p-open'), project('p-secret'), project('p-mixed'), project('p-empty')],
        setups: [
          setup('p-open', 'open'),
          setup('p-secret', 'secret'),
          setup('p-mixed', 'mixed-secret'),
          setup('p-mixed', 'mixed-open')
        ]
      },
      'manual'
    )

    expect(catalog.repos.map((entry) => entry.id)).toEqual(['open', 'mixed-open'])
    expect(catalog.setups.map((entry) => entry.repoId)).toEqual(['open', 'mixed-open'])
    expect(catalog.projects.map((entry) => entry.id)).toEqual(['p-open', 'p-mixed', 'p-empty'])
    expect(JSON.stringify(catalog)).not.toContain('secret')
  })

  it('hides a setup-less project whose source repos are all incognito', () => {
    const catalog = buildMobileProjectSectionCatalog(
      [repo('open'), repo('secret', true)],
      {
        projects: [
          project('p-secret', ['secret']),
          project('p-mixed', ['secret', 'open']),
          project('p-empty')
        ],
        setups: []
      },
      'manual'
    )

    expect(catalog.projects.map((entry) => entry.id)).toEqual(['p-mixed', 'p-empty'])
  })
})

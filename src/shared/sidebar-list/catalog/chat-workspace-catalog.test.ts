import { expect, it } from 'vitest'
import type { Repo } from '../../repository/repo-types'
import { buildMobileProjectSectionCatalog } from './mobile-project-sections-contract'
import { ProjectSectionCatalogSchema } from './project-section-catalog-schema'
import { buildSidebarFeedCatalog } from './sidebar-feed-catalog'

it('preserves chat classification and host identity through the mobile catalog round trip', () => {
  const base: Repo = {
    id: 'same-id',
    path: '/project',
    displayName: 'Project',
    badgeColor: 'blue',
    addedAt: 0
  }
  const wire = buildMobileProjectSectionCatalog(
    [
      base,
      {
        ...base,
        executionHostId: 'runtime:server',
        chatWorkspace: { initialName: 'New project-20261125', autoName: true }
      }
    ],
    { projects: [], setups: [] },
    'manual'
  )
  const decoded = ProjectSectionCatalogSchema.parse(JSON.parse(JSON.stringify(wire)))
  const catalog = buildSidebarFeedCatalog(decoded, [], [])
  expect(
    catalog.repos.map((repo) => ({
      host: repo.executionHostId ?? 'local',
      chat: repo.chatWorkspace ?? null
    }))
  ).toEqual([
    { host: 'local', chat: null },
    { host: 'runtime:server', chat: { initialName: 'New project-20261125', autoName: true } }
  ])
})

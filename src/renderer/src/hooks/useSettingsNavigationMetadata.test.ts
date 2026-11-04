import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  getSettingsTargetHostSelection,
  buildSettingsProjectList
} from '../components/settings/navigation/settings-project-list'
import { describe, expect, it } from 'vitest'
import { buildSettingsNavigationMetadata } from './useSettingsNavigationMetadata'
import type { Repo } from '../../../shared/repo-types'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
} satisfies Repo

describe('settings navigation metadata', () => {
  it('gives repeated repo IDs on distinct hosts unique navigable Settings sections in split modes', () => {
    const common = { ...repo, upstream: { owner: 'org', repo: 'app' } }
    const repos = [
      common,
      { ...common, path: '/server/app', executionHostId: 'runtime:server' as const }
    ]
    const projection = projectHostSetupProjectionFromRepos(repos)
    for (const mode of ['repository', 'host', 'folder'] as const) {
      const grouping = {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        settings: { projectGroupingMode: mode }
      }
      const sections = buildSettingsNavigationMetadata({
        isMac: true,
        isWindows: false,
        isWebClient: false,
        repos,
        projectGrouping: grouping
      }).filter((section) => section.id.startsWith('repo-'))
      expect(new Set(sections.map((section) => section.id)).size).toBe(
        mode === 'repository' ? 1 : 2
      )
      const entries = buildSettingsProjectList(repos, grouping)
      for (const host of ['local', 'runtime:server'] as const) {
        const selection = getSettingsTargetHostSelection(entries, common.id, host)
        expect(sections.some((section) => section.id === `repo-${selection?.selectionKey}`)).toBe(
          true
        )
      }
    }
  })

  // Vitest always has DEV=true; these branches cannot prove the compile-time production gate or bundle exclusion.
})

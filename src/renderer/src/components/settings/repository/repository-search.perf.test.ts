// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { getRepositoryPaneSearchMetadata } from './repository-search-metadata'
import * as worktreeSearch from './worktrees/repository-git-worktree-search-entries'
import {
  buildSettingsProjectList,
  getSettingsTargetHostSelection
} from '../navigation/settings-project-list'

afterEach(() => vi.restoreAllMocks())

it('builds project search indexes without constructing selected-pane groups at fleet scale', () => {
  const buildWorktreeGroups = vi.spyOn(worktreeSearch, 'getRepositoryGitWorktreeSearchMetadata')
  const buildNavigation = (repos: Repo[]) =>
    buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos
    }).filter((section) => section.group === 'repositories')

  for (const projectCount of [12, 120]) {
    buildWorktreeGroups.mockClear()
    const repos = Array.from({ length: projectCount }, (_, index): Repo => ({
      id: `project-${index}`,
      path: `/tmp/project-${index}`,
      displayName: `Project ${index}`,
      badgeColor: '',
      addedAt: 0
    }))
    const initial = buildNavigation(repos)
    expect(initial).toHaveLength(projectCount)
    expect(initial.every((section) => section.searchEntries.length > 0)).toBe(true)
    expect(buildWorktreeGroups).not.toHaveBeenCalled()

    const changed = { ...repos[0], displayName: 'Renamed project' }
    const updatedRepos = [changed, ...repos.slice(1)]
    const updated = buildNavigation(updatedRepos)
    const changedSelection = getSettingsTargetHostSelection(
      buildSettingsProjectList(updatedRepos),
      changed.id,
      'local'
    )
    expect(updated).toHaveLength(projectCount)
    expect(
      updated
        .find((section) => section.id === `repo-${changedSelection?.selectionKey}`)
        ?.searchEntries.some((entry) => entry.keywords?.includes('Renamed project'))
    ).toBe(true)
    expect(buildWorktreeGroups).not.toHaveBeenCalled()

    const selectedPane = getRepositoryPaneSearchMetadata(changed)
    expect(buildWorktreeGroups).toHaveBeenCalledExactlyOnceWith(changed, expect.any(Function))
    expect(
      selectedPane.sparsePresets.some((entry) => entry.keywords?.includes('Renamed project'))
    ).toBe(true)
    expect(selectedPane.identity.some((entry) => entry.keywords?.includes('Renamed project'))).toBe(
      true
    )
  }
})

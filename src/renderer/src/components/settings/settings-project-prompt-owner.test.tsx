// @vitest-environment happy-dom

import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  renderProjectSettingsSections,
  type ProjectSettingsRenderContext
} from './settings-project-section-renderer'

vi.mock('./RepositoryPane', () => ({ RepositoryPane: () => null }))
vi.mock('./SettingsSection', () => ({ SettingsSection: () => null }))

const project: Project = {
  id: 'project',
  displayName: 'Project',
  badgeColor: '',
  sourceRepoIds: ['local-repo', 'remote-repo'],
  createdAt: 1,
  updatedAt: 1
}
const repos: Repo[] = [
  { id: 'local-repo', path: '/local', displayName: 'Project', badgeColor: '', addedAt: 1 },
  {
    id: 'remote-repo',
    path: '/remote',
    displayName: 'Project',
    badgeColor: '',
    addedAt: 1,
    executionHostId: 'runtime:remote'
  }
]
const setups: ProjectHostSetup[] = repos.map((repo) => ({
  id: repo.id,
  repoId: repo.id,
  projectId: project.id,
  hostId: repo.executionHostId ?? 'local',
  path: repo.path,
  displayName: repo.displayName,
  setupState: 'ready',
  setupMethod: 'legacy-repo',
  createdAt: 1,
  updatedAt: 1
}))

describe('Project Settings prompt template host routing', () => {
  it('writes the prompt to the canonical local catalog while the remote setup is selected', async () => {
    const updateProject = vi.fn()
    const context = {
      model: {
        settingsProjectList: [
          {
            projectId: project.id,
            project,
            setups,
            representativeRepoId: 'local-repo',
            selectionKey: project.id
          }
        ],
        settingsProjectHostSelection: { project: 'runtime:remote' },
        settingsProjectSetupSelection: {},
        repos,
        projectHostSetups: setups,
        repoHooksMap: {},
        updateProject,
        updateRepo: vi.fn(),
        removeProjectAllHosts: vi.fn()
      },
      navigation: {
        projectByRepoId: new Map(repos.map((repo) => [repo.id, project])),
        getSectionSearchEntries: () => []
      },
      terminal: {
        isWindowsTerminalHost: false,
        windowsTerminalCapabilities: { wslAvailable: false, wslDistros: [], isLoading: false }
      },
      view: { isSectionMounted: () => true }
    } satisfies ProjectSettingsRenderContext
    const sections = renderProjectSettingsSections(context)
    const section = Array.isArray(sections) ? sections[0] : null
    if (!isValidElement<{ children: ReactNode }>(section)) {
      throw new Error('Missing project settings section')
    }
    const pane = section.props.children
    if (
      !isValidElement<{
        repo: Repo
        updateProject: (id: string, updates: ProjectUpdateArgs['updates']) => Promise<boolean>
      }>(pane)
    ) {
      throw new Error('Missing repository settings pane')
    }
    expect(pane.props.repo.id).toBe('remote-repo')
    await pane.props.updateProject(project.id, {
      linkedWorkItemPromptTemplate: '{{url}} /engineer'
    })
    expect(updateProject).toHaveBeenLastCalledWith(
      project.id,
      { linkedWorkItemPromptTemplate: '{{url}} /engineer' },
      'local'
    )
    await pane.props.updateProject(project.id, { linkedWorkItemPromptTemplate: null })
    expect(updateProject).toHaveBeenLastCalledWith(
      project.id,
      { linkedWorkItemPromptTemplate: null },
      'local'
    )
    await pane.props.updateProject(project.id, {})
    expect(updateProject).toHaveBeenLastCalledWith(project.id, {}, 'runtime:remote')
    context.model.projectHostSetups = []
    context.model.repos = []
    updateProject.mockClear()
    expect(await pane.props.updateProject(project.id, { linkedWorkItemPromptTemplate: null })).toBe(
      false
    )
    expect(updateProject).not.toHaveBeenCalled()
  })
})

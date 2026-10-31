// @vitest-environment happy-dom
import type { Repo } from '../../../../shared/repo-types'
import { RepositoryPane } from './repository/RepositoryPane'
import { RepositorySettingsSession } from './repository/RepositorySettingsSession'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

import { TooltipProvider } from '../ui/tooltip'
import {
  buildSettingsProjectList,
  getSettingsProjectHostRepo,
  getSettingsProjectRemovalScope,
  removeSettingsProjectFromAllHosts
} from './settings-project-list'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([
  'explicit-null',
  'explicit-omitted',
  'legacy-connection',
  'local',
  'nested-x',
  'nested-y'
] as const)(
  'keeps producer-backed %s qualification through the current Settings resolver and real pane',
  async (kind) => {
    const canonical: Repo = {
      id: 'source',
      path: '/srv/source',
      displayName: 'Current source',
      upstream: { owner: 'org', repo: 'source' },
      badgeColor: '',
      addedAt: 0,
      ...(kind === 'local'
        ? {}
        : kind === 'legacy-connection'
          ? { connectionId: 'x' }
          : {
              executionHostId: 'ssh:x',
              ...(kind === 'explicit-omitted'
                ? {}
                : { connectionId: kind.startsWith('nested-') ? 'x' : null })
            })
    }
    const rows: Repo[] = kind.startsWith('nested-')
      ? [
          canonical,
          { ...canonical, path: '/srv/source-y', executionHostId: 'ssh:y', connectionId: 'y' }
        ]
      : [canonical]
    const target = kind.startsWith('nested-')
      ? { kind: 'environment' as const, environmentId: 'E' }
      : { kind: 'local' as const }
    const projection = projectHostSetupProjectionFromRepos(rows)
    const catalog = adoptEndpointProjectCatalog(target, projection.projects, projection.setups)
    const repos = rows.map((repo) => adoptEndpointRepo(target, repo))
    const settings = { ...getDefaultSettings('/tmp'), projectGroupingMode: 'host' as const }
    const update = vi.fn(async () => true)
    Object.assign(window, {
      api: {
        settings: { set: async () => settings },
        hooks: {
          readIssueCommand: async () => ({ status: 'ok', localContent: '', sharedContent: null })
        },
        repos: { getBaseRefDefault: async () => ({ defaultBaseRef: 'main', remoteCount: 1 }) },
        preflight: { detectAgents: async () => [], detectRemoteAgents: async () => [] },
        fs: { readDir: async () => [] }
      }
    })
    useAppStore.setState({
      settings,
      repos,
      projects: catalog.projects,
      projectHostSetups: catalog.setups,
      sparsePresetsByRepo: { source: [] },
      sparsePresetsLoadStatusByRepo: { source: 'loaded' },
      settingsSearchQuery: 'Display Name'
    })
    const entries = buildSettingsProjectList(
      repos,
      getProjectGroupingModelFromState(useAppStore.getState())
    )
    const entry = entries.find((candidate) =>
      candidate.setups.some(
        (setup) =>
          getProjectRepoFilterHost(setup) ===
          (kind === 'nested-y' ? 'ssh:y' : kind === 'local' ? 'local' : 'ssh:x')
      )
    )!
    const setup = entry.setups.find(
      (candidate) =>
        getProjectRepoFilterHost(candidate) ===
        (kind === 'nested-y' ? 'ssh:y' : kind === 'local' ? 'local' : 'ssh:x')
    )!
    expect(setup).toBeDefined()
    const selected = repos[kind === 'nested-y' ? 1 : 0]
    expect(getSettingsProjectHostRepo(entry, repos, setup.hostId, setup.id)).toBe(selected)
    const selectedEntry = entry
    function CurrentPane() {
      const current = useAppStore((state) => state.repos)
      const repo = getSettingsProjectHostRepo(selectedEntry, current, setup.hostId, setup.id)
      return (
        <RepositorySettingsSession
          repo={repo}
          repoId={setup.repoId}
          hostId={setup.hostId}
          isFolder={false}
          updateRepo={update}
        >
          {(session) =>
            repo ? (
              <RepositoryPane
                session={session}
                repo={repo}
                yamlHooks={null}
                hasHooksFile={false}
                hooksInspectionReady
                mayNeedUpdate={false}
                updateRepo={update}
                removeProject={() => {}}
                project={entry.project}
                selectedProjectSetupId={setup.id}
                settingsSelectionKey={selectedEntry.selectionKey}
                removalSetups={selectedEntry.setups}
              />
            ) : (
              <span>Current source unavailable</span>
            )
          }
        </RepositorySettingsSession>
      )
    }
    const view = render(
      <TooltipProvider>
        <CurrentPane />
      </TooltipProvider>
    )
    const name = screen.getByRole('textbox', { name: 'Display Name' })
    expect(name).toHaveProperty('value', selected.displayName)
    fireEvent.compositionStart(name)
    fireEvent.change(name, { target: { value: 'uncommitted name' } })
    act(() =>
      useAppStore.setState({ repos: repos.map((repo) => ({ ...repo, projectGroupOrder: 42 })) })
    )
    expect(screen.getByRole('textbox', { name: 'Display Name' })).toHaveProperty(
      'value',
      'uncommitted name'
    )
    act(() => useAppStore.setState({ repos: [] }))
    expect(screen.getByText('Current source unavailable')).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ repos }))
    expect(screen.getByRole('textbox', { name: 'Display Name' })).toHaveProperty(
      'value',
      'uncommitted name'
    )
    view.unmount()
    if (!kind.startsWith('nested-')) {
      const ambiguous = [
        selected,
        { ...selected, connectionId: selected.connectionId === 'x' ? 'other' : 'x' }
      ]
      expect(getSettingsProjectHostRepo(entry, ambiguous, setup.hostId, setup.id)).toBeUndefined()
    }
    expect(getSettingsProjectHostRepo(entry, [], setup.hostId, setup.id)).toBeUndefined()
  }
)

it('visibly describes each group scope before confirming removal of exactly its registrations', async () => {
  const repo: Repo = {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'Example Repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git'
  }
  const originalApi = window.api
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  Object.assign(window, {
    api: {
      preflight: { detectAgents: async () => [], detectRemoteAgents: async () => [] },
      fs: { readDir: () => Promise.resolve([]) }
    }
  })
  try {
    const repos: Repo[] = [
      { ...repo, id: 'windows-a', path: 'C:\\repos\\app' },
      { ...repo, id: 'windows-b', path: 'D:\\repos\\app' },
      { ...repo, id: 'wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\app' },
      { ...repo, id: 'posix', path: '/repos/app' },
      { ...repo, id: 'ssh', path: '/repos/app', executionHostId: 'ssh:box' as const }
    ].map((entry) => ({
      ...entry,
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/acme/app',
        remoteName: 'origin',
        remoteUrl: 'git@gitlab.com:acme/app.git'
      }
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    useAppStore.setState({
      settingsSearchQuery: repo.displayName,
      settingsSearchInputQuery: repo.displayName,
      settings: getDefaultSettings('/tmp')
    })
    for (const mode of ['repository', 'host', 'folder'] as const) {
      const entries = buildSettingsProjectList(repos, {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        settings: { projectGroupingMode: mode }
      })
      expect(entries).toHaveLength(mode === 'repository' ? 1 : mode === 'host' ? 4 : 5)
      for (const entry of entries) {
        const displayedRepo = repos.find((candidate) => candidate.id === entry.representativeRepoId)
        expect(displayedRepo).toBeDefined()
        if (!displayedRepo) {
          throw new Error('Missing representative')
        }
        const remove = vi.fn(async () => {})
        let removal: Promise<void> | undefined
        act(() => {
          root.render(
            React.createElement(
              TooltipProvider,
              null,
              React.createElement(RepositoryPane, {
                key: entry.selectionKey,
                repo: displayedRepo,
                yamlHooks: null,
                hasHooksFile: false,
                hooksInspectionReady: true,
                mayNeedUpdate: false,
                updateRepo: vi.fn(),
                removalScope: getSettingsProjectRemovalScope(entry),
                removeProject: () => {
                  removal = removeSettingsProjectFromAllHosts(entry.setups, remove)
                }
              })
            )
          )
        })
        const scopeText = Array.from(container.querySelectorAll('p')).find((p) =>
          p.textContent?.startsWith('Remove this')
        )?.textContent
        expect(scopeText).toContain(
          mode === 'repository'
            ? 'on all configured hosts'
            : mode === 'folder'
              ? 'Other checkouts of this project stay'
              : 'on '
        )
        if (mode === 'host') {
          if (entry.representativeRepoId.startsWith('windows')) {
            expect(scopeText).toContain('Windows')
          }
          if (entry.representativeRepoId === 'wsl') {
            expect(scopeText).toContain('Ubuntu (WSL)')
          }
          if (entry.representativeRepoId === 'ssh') {
            expect(scopeText).toContain('box')
          }
        }
        const button = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove Project"]'
        )
        expect(button).not.toBeNull()
        act(() => button?.click())
        expect(remove).not.toHaveBeenCalled()
        expect(container.querySelector('button[aria-label="Confirm Remove Project"]')).toBe(button)
        await act(async () => {
          button?.click()
          await removal
        })
        expect(remove.mock.calls).toEqual(
          entry.setups.map((setup) => [
            setup.repoId,
            { hostId: setup.hostId, errorFeedback: 'toast' }
          ])
        )
      }
    }
  } finally {
    act(() => root.unmount())
    container.remove()
    Object.assign(window, { api: originalApi })
  }
})

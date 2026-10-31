// @vitest-environment happy-dom
import type { Repo } from '../../../../shared/repo-types'
import { RepositoryPane } from './repository/RepositoryPane'
import { RepositorySettingsSession } from './repository/RepositorySettingsSession'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import { act } from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

import { TooltipProvider } from '../ui/tooltip'
import { buildSettingsProjectList, getSettingsProjectHostRepo } from './settings-project-list'
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

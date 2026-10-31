import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { createUIStore } from '../../store/slices/ui-slice-test-harness'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../../shared/project-section-grouping'
import {
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo,
  getSettingsTargetHostSelection,
  type SettingsProject
} from './settings-project-list'

const gitRemoteIdentity = {
  canonicalKey: 'gitlab.com/acme/app',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.com:acme/app.git'
}

function makeRepo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '', addedAt: 0, gitRemoteIdentity }
}

const nativeA = makeRepo('native-a', 'C:\\projects\\app-a')
const nativeB = makeRepo('native-b', 'C:\\projects\\app-b')
const wslA = makeRepo('wsl-a', '\\\\wsl.localhost\\Ubuntu\\home\\fixture\\app-a')
const wslB = makeRepo('wsl-b', '\\\\wsl.localhost\\Ubuntu\\home\\fixture\\app-b')

function pickRepo(
  store: ReturnType<typeof createUIStore>,
  entries: SettingsProject[],
  repo: Repo
): void {
  const target = getSettingsTargetHostSelection(entries, repo.id, 'local')
  if (!target) {
    throw new Error(`Missing Settings target for ${repo.id}`)
  }
  store
    .getState()
    .setSettingsProjectHostSelection(target.selectionKey, target.hostId, target.setupId)
}

function selectedRepo(store: ReturnType<typeof createUIStore>, repos: Repo[], repo: Repo): Repo {
  const entry = buildSettingsProjectList(repos).find((candidate) =>
    candidate.setups.some((setup) => setup.repoId === repo.id)
  )
  if (!entry) {
    throw new Error(`Missing Settings entry for ${repo.id}`)
  }
  const state = store.getState()
  const selection = getSettingsEntryHostSelection(
    entry,
    state.settingsProjectHostSelection,
    state.settingsProjectSetupSelection
  )
  const result = getSettingsProjectHostRepo(entry, repos, selection.hostId, selection.setupId)
  if (!result) {
    throw new Error(`Missing selected Settings repo for ${repo.id}`)
  }
  return result
}

describe('Settings grouping changes', () => {
  it('keeps the exact selected checkout when switching from repository to folder and back', () => {
    const repos = [nativeA, nativeB, wslA, wslB]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const store = createUIStore()
    pickRepo(store, buildSettingsProjectList(repos), nativeB)
    const split = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: 'folder' }
    })
    const entry = split.find((candidate) =>
      candidate.setups.some((setup) => setup.repoId === nativeB.id)
    )
    if (!entry) {
      throw new Error('Missing selected checkout')
    }
    const state = store.getState()
    const selection = getSettingsEntryHostSelection(
      entry,
      state.settingsProjectHostSelection,
      state.settingsProjectSetupSelection
    )
    expect(
      getSettingsProjectHostRepo(entry, repos, selection.hostId, selection.setupId)?.path
    ).toBe(nativeB.path)
    pickRepo(store, split, wslA)
    expect(selectedRepo(store, repos, nativeA).path).toBe(wslA.path)
  })

  it('keeps non-checkout setups in their host group in folder mode, matching the sidebar', () => {
    const repos = [nativeA, nativeB, wslA]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const grouping = {
      settings: { projectGroupingMode: 'folder' as const },
      projects: projection.projects,
      projectHostSetups: projection.setups.map((setup) =>
        setup.repoId === nativeA.id ? { ...setup, setupMethod: 'provisioned' as const } : setup
      )
    }
    const sidebar = getProjectGroupingForRepo(
      nativeA.id,
      new Map(repos.map((repo) => [repo.id, repo])),
      buildProjectGroupingIndex(grouping)
    )
    const entry = buildSettingsProjectList(repos, grouping).find((candidate) =>
      candidate.setups.some((setup) => setup.repoId === nativeA.id)
    )
    expect(entry?.selectionKey).toBe(sidebar.key)
    expect(sidebar.key).toContain('::host:')
    expect(sidebar.key).not.toContain('::setup:')
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  closeTestStores,
  createSqliteTestStore,
  withPlatform,
  writePersistedStateJson
} from '../../src/main/persistence/persistence-test-harness'
import { Store } from '../../src/main/persistence/loading-store/store'
import { rebuildRepoBackedProjectState } from '../../src/main/orca-profiles/profile-project-state-file'
import { resolveLocalWorkspaceRuntime } from '../../src/main/local-project-runtime-resolution'
import { getDefaultPersistedState } from '../../src/shared/constants'
import type { PersistedState } from '../../src/shared/persisted-state-types'
import type { Repo } from '../../src/shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../src/shared/project-host-setup-projection'
import { getLocalRepoProjectExecutionRuntimeContext } from '../../src/renderer/src/lib/local-preflight-context'
import { useAppStore } from '../../src/renderer/src/store'

it('keeps the exact surviving project runtime through a three-local-checkout handoff, profile rebuild and reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sta10541-runtime-handoff-'))
  const dataFile = join(root, 'state.json')
  const exported = join(root, 'export.json')
  const projectId = 'github:acme/app'
  const repo = (id: string, path: string, addedAt: number): Repo => ({
    id,
    path,
    addedAt,
    displayName: 'app',
    badgeColor: '',
    upstream: { owner: 'acme', repo: 'app' }
  })
  const repos = [
    repo('a', 'C:/app-a', 1),
    repo('b', 'C:/app-b', 2),
    repo('c', '\\\\wsl.localhost\\Ubuntu\\home\\me\\app-wsl', 3)
  ]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const state = getDefaultPersistedState(root)
  state.repos = repos
  state.projects = [...projection.projects]
  state.projectHostSetups = [
    ...projection.setups,
    {
      id: 'pending-b',
      projectId: 'repo:b',
      repoId: '',
      hostId: 'ssh:extra',
      path: '',
      displayName: 'extra',
      setupState: 'not-set-up',
      setupMethod: 'provisioned',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  writePersistedStateJson(dataFile, JSON.stringify(state))
  try {
    let store = createSqliteTestStore(Store, { dataFile })
    expect(store.getProjects().map((row) => [row.id, row.sourceRepoIds])).toEqual([
      [projectId, ['a', 'c']],
      ['repo:b', ['b']]
    ])
    store.updateProject(projectId, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    store.updateProject('repo:b', { localWindowsRuntimePreference: { kind: 'windows-host' } })
    store.writeProfileStateJsonExport(exported)
    await closeTestStores()
    store = createSqliteTestStore(Store, { dataFile })
    expect(
      store.getProjects().find((row) => row.id === 'repo:b')?.localWindowsRuntimePreference
    ).toEqual({ kind: 'windows-host' })
    const before: PersistedState = JSON.parse(await readFile(exported, 'utf8'))
    const concrete = store.getRepos().filter((row) => row.id !== 'a')
    store.removeProjectForHost({ id: 'a', executionHostId: 'local' })
    const remaining = repos.slice(1)
    const rebuilt = rebuildRepoBackedProjectState({ ...before, repos: remaining })
    expect(store.getProjects()).toEqual(rebuilt.projects)
    expect(store.getProjectHostSetups()).toEqual(rebuilt.projectHostSetups)
    const projects = store.getProjects()
    const setups = store.getProjectHostSetups()
    expect(projects).toEqual([
      expect.objectContaining({
        id: projectId,
        sourceRepoIds: ['b', 'c'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ])
    expect(setups.filter((row) => row.id === 'pending-b')).toEqual([
      expect.objectContaining({
        projectId,
        repoId: '',
        hostId: 'ssh:extra',
        path: '',
        setupState: 'not-set-up'
      })
    ])
    expect(store.getRepos()).toEqual(concrete)
    expect(
      setups.filter((row) => row.repoId).map((row) => [row.repoId, row.path, row.hostId])
    ).toEqual(remaining.map((row) => [row.id, row.path, 'local']))
    store.writeProfileStateJsonExport(exported)
    await closeTestStores()
    store = createSqliteTestStore(Store, { dataFile })
    expect(store.getProjects()).toEqual(projects)
    expect(store.getProjectHostSetups()).toEqual(setups)
    expect(store.getRepos()).toEqual(concrete)
    const saved: PersistedState = JSON.parse(await readFile(exported, 'utf8'))
    expect(rebuildRepoBackedProjectState(saved).projects).toEqual(projects)
    await withPlatform('win32', async () => {
      const renderer = {
        ...useAppStore.getInitialState(),
        repos: store.getRepos(),
        settings: store.getSettings(),
        endpointProjects: store.getProjects(),
        endpointProjectHostSetups: store.getProjectHostSetups()
      }
      for (const target of store.getRepos()) {
        const main = resolveLocalWorkspaceRuntime(store, target, target.path)
        expect(main).toMatchObject({
          status: 'resolved',
          runtime: { kind: 'wsl', distro: 'Ubuntu', projectId, reason: 'project-override' }
        })
        expect(getLocalRepoProjectExecutionRuntimeContext(renderer, target.id, 'win32')).toEqual(
          main
        )
      }
    })
  } finally {
    await closeTestStores()
    await rm(root, { recursive: true, force: true })
  }
})

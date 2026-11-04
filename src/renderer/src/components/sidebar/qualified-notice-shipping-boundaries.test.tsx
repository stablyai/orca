// @vitest-environment happy-dom
import {
  fetchWorktreesFixture,
  local,
  detected,
  ShippingSidebar
} from './qualified-notice-actions-test-fixtures'
import { act } from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { worktree } from './worktree-list-groups-test-fixtures'

function hasConcreteRepoUpdates(
  updates: Parameters<AppState['updateRepo']>[1]
): updates is Parameters<AppState['updateRepo']>[1] & Partial<Repo> {
  return (
    updates.sourceControlAi !== null &&
    updates.externalWorktreeVisibility !== null &&
    updates.agentWorktreeVisibility !== null &&
    updates.externalWorktreeDiscoverySuppressedAt !== null &&
    updates.ghAccount !== null
  )
}

/** The preload surface the new-workspace composer reads while it opens. */
function installComposerApi(): void {
  Object.assign(window, {
    api: {
      ...window.api,
      platform: { get: () => ({ platform: 'darwin' }) },
      preflight: { detectAgents: async () => [], detectRemoteAgents: async () => [] },
      worktrees: { listRetiredNames: async () => EMPTY_RETIRED_NAME_REGISTRY },
      repos: {
        getSlug: async () => null,
        getHooks: async () => ({ hooks: null, hasHooks: false }),
        getBaseRefDefault: async () => ({ defaultBaseRef: 'main', remoteCount: 1 })
      },
      sparsePresets: { list: async () => [] },
      gh: {
        repoSlug: async () => null,
        listWorkItems: async () => ({ items: [], hasMore: false })
      },
      hooks: {
        check: async () => ({ hooks: null, hasHooks: false, mayNeedUpdate: false }),
        readIssueCommand: async () => ({ status: 'ok', localContent: null, sharedContent: null })
      }
    }
  })
}

it('keeps beta recoverable after its real Keep hidden action through the shipping merged header and one exact recovery list', async () => {
  const alpha = {
    ...local,
    id: 'alpha',
    displayName: 'Harbor',
    path: '/alpha',
    upstream: { owner: 'org', repo: 'harbor' }
  }
  const beta = { ...alpha, id: 'beta', path: '/beta' }
  const repos = [alpha, beta]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const betaHidden = detected('/beta/.claude/worktrees/hidden', {
    id: 'beta-hidden',
    repoId: beta.id,
    displayName: 'beta hidden',
    ownership: 'external',
    hostId: 'local'
  })
  const updateRepo = vi.fn<AppState['updateRepo']>(async (id, updates, options) => {
    if (!hasConcreteRepoUpdates(updates)) {
      throw new Error('This fixture expects concrete repo updates, not clear sentinels')
    }
    useAppStore.setState((state) => ({
      repos: state.repos.map((entry) =>
        entry.id === id && getRepoExecutionHostId(entry) === (options?.hostId ?? 'local')
          ? { ...entry, ...updates }
          : entry
      )
    }))
    return true
  })
  const { fetchWorktrees, ordinary: fetch } = fetchWorktreesFixture()
  fetch.mockImplementation(async (id) => {
    useAppStore.setState((state) => {
      const current = state.repos.find((entry) => entry.id === id)!
      const visible = current.importedExternalWorktreePaths?.includes(betaHidden.path) === true
      return {
        detectedWorktreesByRepo: {
          ...state.detectedWorktreesByRepo,
          [id]: {
            repoId: id,
            authoritative: true,
            source: 'git',
            worktrees: id === beta.id ? [{ ...betaHidden, visible }] : []
          }
        }
      }
    })
    return true
  })
  Object.assign(window, {
    api: { ...window.api, platform: { get: () => ({ platform: 'darwin' }) } }
  })
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: getDefaultSettings('/tmp'),
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    worktreesByRepo: {
      alpha: [{ ...worktree, id: 'alpha-main', repoId: 'alpha', hostId: 'local' }]
    },
    detectedWorktreesByRepo: {
      beta: { repoId: beta.id, authoritative: true, source: 'git', worktrees: [betaHidden] }
    },
    fetchWorktrees,
    updateRepo
  })
  const user = userEvent.setup()
  render(<ShippingSidebar />)
  const dismiss = screen.getByRole('button', { name: /Keep 1 discovered worktree.*hidden/ })
  await user.click(dismiss)
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Keep 1 discovered worktree.*hidden/ })).toBeNull()
  )
  await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
  await user.click(screen.getByRole('menuitem', { name: 'Non-Orca worktrees' }))
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Hidden worktrees (1)' })).toBeTruthy()
  )
  expect(
    screen.getByRole('region', { name: 'Hidden worktrees (1)' }).querySelectorAll('ul')
  ).toHaveLength(1)
  const show = screen.getByRole('button', { name: /Show beta hidden at \/beta/ })
  await waitFor(() => expect(show).toHaveProperty('disabled', false))
  await user.click(show)
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Hidden worktrees (0)' })).toBeTruthy()
  )
  expect(
    updateRepo.mock.calls.some(
      ([id, patch, options]) =>
        id === 'beta' &&
        patch.importedExternalWorktreePaths?.includes(betaHidden.path) &&
        options?.hostId === 'local'
    )
  ).toBe(true)
  expect(updateRepo.mock.calls.every(([id]) => id === 'beta')).toBe(true)
  expect(fetch).toHaveBeenCalledWith('beta', {
    requireAuthoritative: true,
    executionHostId: 'local'
  })
  expect(useAppStore.getState().repos[0]).toBe(alpha)
})

it('opens the shipping logical-group composer despite a disconnected raw SSH ordering scalar and lets the user choose beta', async () => {
  const alpha = {
    ...local,
    id: 'same',
    displayName: 'Harbor',
    path: '/alpha',
    badgeColor: '#123456',
    upstream: { owner: 'org', repo: 'harbor' }
  }
  const beta = { ...alpha, id: 'beta', path: '/beta' }
  const sshTwin = { ...alpha, connectionId: 'box', path: '/ssh', badgeColor: '#654321' }
  const repos = [alpha, beta, sshTwin]
  const projection = projectHostSetupProjectionFromRepos(repos)
  installComposerApi()
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: getDefaultSettings('/tmp'),
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    workspaceHostScope: 'all',
    activeRepoId: alpha.id,
    detectedAgentIds: [],
    sshTargetLabels: new Map([['box', 'Box']]),
    worktreesByRepo: {
      same: [{ ...worktree, id: 'alpha-main', repoId: 'same', hostId: 'local' }],
      beta: [{ ...worktree, id: 'beta-main', repoId: 'beta', hostId: 'local', sortOrder: 1 }]
    }
  })
  const user = userEvent.setup()
  render(<ShippingSidebar />)
  const create = screen.getByRole('button', { name: 'Create workspace for Harbor' })
  const header = create.closest('[data-project-grouping-key]')
  expect(header?.querySelector('svg[style]')?.getAttribute('style')).toContain('#123456')
  expect(header?.getAttribute('aria-expanded')).toBe('true')
  expect(create).toHaveProperty('disabled', false)
  await user.click(create)
  // The SSH twin shows no rows here, so it is not the header's contextual checkout.
  expect(useAppStore.getState().modalData).toMatchObject({
    initialProjectScope: { key: 'project:github:org/harbor', context: undefined }
  })
  expect(useAppStore.getState().modalData).not.toHaveProperty('initialRepoId')
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  expect(screen.getByRole('dialog').textContent).toContain('Harbor')
  await user.click(screen.getByRole('combobox', { name: 'Run on' }))
  await user.click(screen.getByRole('option', { name: /\/beta/ }))
  expect(document.querySelector('[data-run-target-combobox-root]')?.textContent).toContain('Local')
  expect(screen.getByRole('dialog').textContent).not.toContain('Connect Harbor')
})

it('routes the shipping merged Remove Project menu to current Settings scope and its two-click dirty/refusal/serial persistence owner', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createStore, closeTestStores, readPersistedState, testState } =
    await import('../../../../main/persistence/persistence-test-harness')
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr35595-header-removal-'))
  testState.dir = directory
  const disk = createStore()
  const alpha = {
    ...local,
    id: 'alpha',
    displayName: 'Harbor',
    path: '/alpha',
    upstream: { owner: 'org', repo: 'harbor' }
  }
  const beta = { ...alpha, id: 'beta', path: '/beta' }
  const unrelated = { ...alpha, id: 'other', path: '/other', upstream: null, displayName: 'Other' }
  for (const entry of [alpha, beta, unrelated]) {
    disk.addRepo(entry)
  }
  const projection = projectHostSetupProjectionFromRepos([alpha, beta, unrelated])
  const settings = getDefaultSettings('/tmp')
  let failBeta = true
  let releaseAlpha: (() => void) | undefined
  const removeForHost = vi.fn<Window['api']['repos']['removeForHost']>(
    async ({ repoId, hostId }) => {
      if (repoId === alpha.id) {
        await new Promise<void>((resolve) => {
          releaseAlpha = resolve
        })
      }
      if (repoId === beta.id && failBeta) {
        throw new Error('beta host refused')
      }
      const host = parseExecutionHostId(hostId)
      if (!host || host.id !== hostId) {
        throw new Error('Expected the original exact execution host')
      }
      disk.removeProjectForHost({ id: repoId, executionHostId: host.id })
    }
  )
  Object.assign(window, {
    api: {
      ...window.api,
      platform: { get: () => ({ platform: 'darwin' }) },
      settings: { get: async () => settings },
      keybindings: { get: async () => [] },
      updater: { getVersion: async () => '0.0.0' },
      runtimeEnvironments: { list: async () => [] },
      pty: { management: { listSessions: async () => ({ sessions: [] }) } },
      gh: { checkOrcaStarred: async () => false, repoSlug: async () => null },
      hooks: {
        check: async () => ({ hasHooks: false, hooks: null, mayNeedUpdate: false }),
        readIssueCommand: async () => ({ status: 'ok', localContent: null, sharedContent: null })
      },
      sparsePresets: { list: async () => [] },
      preflight: { detectAgents: async () => [] },
      fs: { readDir: async () => [] },
      repos: {
        removeForHost,
        getBaseRefDefault: async () => ({ defaultBaseRef: 'main', remoteCount: 1 })
      }
    }
  })
  useAppStore.setState({
    repos: [alpha, beta, unrelated],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings,
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    worktreesByRepo: {
      alpha: [{ ...worktree, id: 'alpha-main', repoId: 'alpha', hostId: 'local' }],
      beta: [{ ...worktree, id: 'beta-main', repoId: 'beta', hostId: 'local' }]
    }
  })
  const user = userEvent.setup()
  try {
    render(<ShippingSidebar includeSettings />)
    await user.click(screen.getByRole('button', { name: 'Project actions for Harbor' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove Project' }))
    expect(removeForHost).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Project' })).toBeTruthy())
    expect(screen.getByText(/Remove this project from Orca on all configured hosts/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
    const dirty = {
      id: 'dirty-beta',
      worktreeId: 'beta-main',
      filePath: '/beta/pending.ts',
      relativePath: 'pending.ts',
      language: 'typescript',
      isDirty: true,
      mode: 'edit' as const
    }
    act(() => useAppStore.setState({ openFiles: [dirty] }))
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
    expect(removeForHost).not.toHaveBeenCalled()
    expect(disk.getRepos().map((entry) => entry.id)).toEqual(['alpha', 'beta', 'other'])
    act(() => useAppStore.setState({ openFiles: [] }))
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    // Material membership change disarms without remounting the current concrete pane.
    const extra = { ...beta, id: 'late', path: '/late' }
    const expanded = projectHostSetupProjectionFromRepos([alpha, beta, extra, unrelated])
    act(() =>
      useAppStore.setState({
        repos: [alpha, beta, extra, unrelated],
        projects: expanded.projects,
        projectHostSetups: expanded.setups
      })
    )
    expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
    act(() =>
      useAppStore.setState({
        repos: [alpha, beta, unrelated],
        projects: projection.projects,
        projectHostSetups: projection.setups
      })
    )
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
    await waitFor(() => expect(releaseAlpha).toBeTypeOf('function'))
    disk.addRepo(extra)
    act(() =>
      useAppStore.setState({
        repos: [alpha, beta, extra, unrelated],
        projects: expanded.projects,
        projectHostSetups: expanded.setups
      })
    )
    act(() => releaseAlpha?.())
    await waitFor(() => expect(removeForHost).toHaveBeenCalledTimes(2))
    quiet.mockRestore()
    expect(removeForHost.mock.calls.map(([target]) => target)).toEqual([
      { repoId: 'alpha', hostId: 'local' },
      { repoId: 'beta', hostId: 'local' }
    ])
    expect(
      disk
        .getRepos()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['beta', 'late', 'other'])
    expect(
      useAppStore
        .getState()
        .repos.map((entry) => entry.id)
        .sort()
    ).toEqual(['beta', 'late', 'other'])
    // The failed member remains visible and can be removed through the same ordinary Settings control.
    failBeta = false
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Project' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Remove Project' }))
    await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
    await waitFor(() =>
      expect(useAppStore.getState().repos.map((entry) => entry.id)).toEqual(['other'])
    )
    disk.flush()
    await closeTestStores()
    expect(readPersistedState().repos.map((entry) => entry.id)).toEqual(['other'])
  } finally {
    cleanup()
    await closeTestStores()
    rmSync(directory, { recursive: true, force: true })
  }
})

const harbor = {
  ...local,
  id: 'same',
  displayName: 'Harbor',
  path: '/alpha',
  upstream: { owner: 'org', repo: 'harbor' }
}

function openHarborSidebar(
  repos: Repo[],
  worktreesByRepo: AppState['worktreesByRepo'],
  visibleWorkspaceHostIds: AppState['visibleWorkspaceHostIds'] = null
) {
  cleanup()
  installComposerApi()
  const projection = projectHostSetupProjectionFromRepos(repos)
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: getDefaultSettings('/tmp'),
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    workspaceHostScope: 'all',
    activeRepoId: null,
    activeModal: 'none',
    modalData: {},
    detectedAgentIds: [],
    sshTargetLabels: new Map([['box', 'Box']]),
    sshConnectionStates: new Map(),
    visibleWorkspaceHostIds,
    worktreesByRepo
  })
  render(<ShippingSidebar />)
  return projection
}

it('keeps a project whose rows all sit on its disconnected SSH anchor on the group chooser, seeding the anchor when reconnected', async () => {
  // repoMap keeps the later SSH registration of `same` as the header's anchor; local has no rows.
  const sshAnchor = { ...harbor, connectionId: 'box', path: '/ssh' }
  openHarborSidebar([harbor, sshAnchor], {
    same: [
      { ...worktree, id: 'ssh-one', repoId: 'same', hostId: 'ssh:box' },
      { ...worktree, id: 'ssh-two', repoId: 'same', hostId: 'ssh:box', path: '/ssh/two' }
    ]
  })
  const user = userEvent.setup()
  const create = screen.getByRole('button', { name: 'Create workspace for Harbor' })
  expect(create).toHaveProperty('disabled', false)
  await user.click(create)
  const opened = useAppStore.getState().modalData
  expect(opened).toMatchObject({
    initialProjectScope: {
      key: 'project:github:org/harbor',
      context: { repoId: 'same', hostId: 'ssh:box' }
    }
  })
  expect(opened).not.toHaveProperty('initialRepoId')
  expect(opened).not.toHaveProperty('initialWorkspaceTarget')
  // The configured Box stays selectable, so its shown seed is preselected behind Connect; local can be chosen.
  await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Connect Harbor'))
  await user.click(screen.getByRole('combobox', { name: 'Run on' }))
  await user.click(screen.getByRole('option', { name: /\/alpha/ }))
  expect(document.querySelector('[data-run-target-combobox-root]')?.textContent).toContain('Local')
  expect(screen.getByRole('dialog').textContent).not.toContain('Connect Harbor')

  act(() => {
    useAppStore.getState().closeModal()
    useAppStore.setState({
      sshConnectionStates: new Map([
        ['box', { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0 }]
      ])
    })
  })
  await user.click(screen.getByRole('button', { name: 'Create workspace for Harbor' }))
  // Reconnected, the shown anchor still wins only as the chooser's context, never as an explicit pin.
  expect(useAppStore.getState().modalData).toEqual(opened)
  await waitFor(() =>
    expect(document.querySelector('[data-run-target-combobox-root]')?.textContent).toContain('Box')
  )
})

it('keeps the gate of a disconnected Box copy in host sections while its local copy stays creatable', () => {
  const sshMember = { ...harbor, connectionId: 'box', path: '/ssh' }
  openHarborSidebar(
    [harbor, sshMember],
    {
      same: [
        { ...worktree, id: 'local-one', repoId: 'same', hostId: 'local' },
        { ...worktree, id: 'ssh-one', repoId: 'same', hostId: 'ssh:box', path: '/ssh/one' }
      ]
    },
    ['local', 'ssh:box']
  )
  // Each host section's copy is an explicit host action; only Box's waits for its connection.
  expect(
    screen.getByRole('button', {
      name: 'Reconnect SSH target before creating workspaces for Harbor'
    })
  ).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Create new worktree for Harbor' })).toHaveProperty(
    'disabled',
    false
  )
})

it('opens same-host clones whose anchor shows no rows on the group chooser with no header seed', async () => {
  const hiddenAnchor = { ...harbor, id: 'clone-a', connectionId: 'box', path: '/box/a' }
  const shownClone = { ...hiddenAnchor, id: 'clone-b', path: '/box/b' }
  const emptyLocal = { ...harbor, id: 'clone-c', path: '/local/c' }
  const projection = openHarborSidebar([hiddenAnchor, shownClone, emptyLocal], {
    'clone-b': [{ ...worktree, id: 'b-main', repoId: 'clone-b', hostId: 'ssh:box' }]
  })
  const user = userEvent.setup()
  const create = screen.getByRole('button', { name: 'Create workspace for Harbor' })
  expect(create).toHaveProperty('disabled', false)
  await user.click(create)
  expect(useAppStore.getState().modalData).toMatchObject({
    initialProjectScope: { key: 'project:github:org/harbor', context: undefined }
  })
  expect(useAppStore.getState().modalData).not.toHaveProperty('initialRepoId')
  expect(projection.setups.map((setup) => setup.repoId)).toEqual(['clone-a', 'clone-b', 'clone-c'])
  // With no header seed and no other context, the all-hosts chooser falls to the local member.
  await waitFor(() =>
    expect(document.querySelector('[data-run-target-combobox-root]')?.textContent).toContain(
      'Local'
    )
  )
  await user.click(screen.getByRole('combobox', { name: 'Run on' }))
  expect(screen.getByRole('option', { name: /\/box\/b/ })).toBeTruthy()
})

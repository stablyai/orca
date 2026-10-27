// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './repository/execution/RepositoryHostSetupsSection'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildSettingsProjectList } from './settings-project-list'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import type { Repo } from '../../../../shared/repo-types'

it.each(['claimant', 'outclaimed', 'folder', 'remoteless'])(
  '%s preserves the approved host actions',
  async (kind) => {
    const repos: Repo[] = (kind === 'claimant' || kind === 'outclaimed' ? ['a', 'b'] : [kind]).map(
      (id, index) => ({
        id,
        path: `/${id}`,
        displayName: id,
        addedAt: index + 1,
        badgeColor: '',
        kind: kind === 'folder' ? 'folder' : 'git',
        ...(kind === 'claimant' || kind === 'outclaimed'
          ? { upstream: { owner: 'acme', repo: 'app' } }
          : {})
      })
    )
    const projection = projectHostSetupProjectionFromRepos(repos)
    const repo = repos[kind === 'outclaimed' ? 1 : 0]
    const projectId = projection.setups[kind === 'outclaimed' ? 1 : 0].projectId
    const createProjectHostSetup = vi.fn().mockResolvedValue(null)
    const existing = {
      ...projection.setups[0],
      id: 'pending',
      repoId: '',
      projectId,
      hostId: 'ssh:configured' as const,
      path: '',
      setupMethod: 'provisioned' as const,
      setupState: 'not-set-up' as const
    }
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      repos,
      endpointProjects: [...projection.projects],
      endpointProjectHostSetups: [...projection.setups, existing],
      sshTargetLabels: new Map([
        ['extra', 'extra'],
        ['configured', 'configured']
      ]),
      createProjectHostSetup
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const button = (label: string) =>
      Array.from(container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes(label)
      )
    const click = async (label: string) => {
      expect(button(label), label).toBeTruthy()
      expect(button(label)?.disabled).toBe(false)
      await act(async () => {
        button(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    try {
      await act(async () =>
        root.render(
          React.createElement(RepositoryHostSetupsSection, {
            repo,
            forceVisible: true,
            searchQuery: '',
            searchEntries: []
          })
        )
      )
      expect(container.textContent).toContain('configured')
      expect(container.textContent).toContain('Not set up')
      if (kind === 'outclaimed') {
        expect(button('Add to another host')).toBeUndefined()
        expect(createProjectHostSetup).not.toHaveBeenCalled()
      } else {
        await click('Add to another host')
        await click('Add host placeholder')
        await click('Add extra')
        expect(createProjectHostSetup).toHaveBeenCalledWith({
          projectId,
          hostId: 'ssh:extra',
          displayName: repo.displayName,
          setupState: 'not-set-up',
          setupMethod: 'provisioned'
        })
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
      useAppStore.setState(useAppStore.getInitialState(), true)
    }
  }
)

it('reaches and edits/removes a reloaded handoff row through B Settings and concrete setup addressing', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const repo: Repo = {
    id: 'b',
    path: '/b',
    displayName: 'b',
    badgeColor: '',
    addedAt: 2,
    upstream: { owner: 'acme', repo: 'app' }
  }
  const remote: Repo = { ...repo, id: 'c', path: '/c', executionHostId: 'runtime:remote' }
  const projection = projectHostSetupProjectionFromRepos([repo, remote])
  const project = projection.projects[0]
  const pending = {
    ...projection.setups[0],
    id: 'pending-b',
    repoId: '',
    hostId: 'ssh:extra' as const,
    path: '',
    setupState: 'not-set-up' as const,
    setupMethod: 'provisioned' as const
  }
  // Persistence/profile lifecycle pins this exact independent row's successor before serving it.
  const saved = JSON.parse(
    JSON.stringify({ projects: projection.projects, setups: [...projection.setups, pending] })
  )
  const updated = { ...pending, displayName: 'Saved pending host' }
  const updateHostSetup = vi.fn().mockResolvedValue({ project, setup: updated })
  const deleteHostSetup = vi.fn().mockResolvedValue({ project, setup: updated })
  const api = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { projects: { updateHostSetup, deleteHostSetup } }
  })
  useAppStore.setState({
    repos: [repo, remote],
    endpointProjects: saved.projects,
    endpointProjectHostSetups: saved.setups,
    sshTargetLabels: new Map([['extra', 'Extra']])
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    const canonical = getProjectHostSetupProjectionFromState(useAppStore.getState())
    const entries = buildSettingsProjectList([repo, remote], {
      projects: canonical.projects,
      projectHostSetups: canonical.setups
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].representativeRepoId).toBe('b')
    expect(entries[0].setups.find((setup) => setup.id === 'pending-b')?.projectId).toBe(project.id)
    await act(async () =>
      root.render(
        React.createElement(RepositoryHostSetupsSection, {
          repo,
          forceVisible: true,
          searchQuery: '',
          searchEntries: []
        })
      )
    )
    expect(container.textContent).toContain('Extra')
    expect(container.textContent).toContain('Not set up')
    await act(async () => {
      await useAppStore.getState().updateProjectHostSetup({
        setupId: 'pending-b',
        updates: { displayName: updated.displayName }
      })
    })
    expect(updateHostSetup).toHaveBeenCalledExactlyOnceWith({
      setupId: 'pending-b',
      updates: { displayName: updated.displayName }
    })
    expect(
      useAppStore.getState().endpointProjectHostSetups.find((setup) => setup.id === 'pending-b')
        ?.displayName
    ).toBe(updated.displayName)
    const remove = Array.from(container.querySelectorAll('button')).find(
      (node) => node.textContent === 'Remove'
    )
    expect(remove).toBeTruthy()
    await act(async () => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(deleteHostSetup).toHaveBeenCalledExactlyOnceWith({
      setupId: 'pending-b',
      hostId: pending.hostId
    })
    expect(
      useAppStore.getState().endpointProjectHostSetups.some((setup) => setup.id === 'pending-b')
    ).toBe(false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    useAppStore.setState(useAppStore.getInitialState(), true)
    if (api) {
      Object.defineProperty(window, 'api', api)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
})

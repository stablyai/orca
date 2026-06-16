// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalExecutionHostLabel, toSshExecutionHostId } from '../../../../shared/execution-host'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

let container: HTMLDivElement
let root: Root
const localHostLabel = getLocalExecutionHostLabel()

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

function makeProject({ id, ...overrides }: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    id,
    displayName: 'Orca',
    badgeColor: '#737373',
    sourceRepoIds: ['local-repo', 'remote-repo'],
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function makeSetup(
  overrides: Partial<ProjectHostSetup> &
    Pick<ProjectHostSetup, 'id' | 'projectId' | 'repoId' | 'hostId' | 'path'>
): ProjectHostSetup {
  return {
    displayName: 'Orca',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderSection(repo: Repo): void {
  act(() => {
    root.render(
      React.createElement(RepositoryHostSetupsSection, {
        repo,
        forceVisible: true,
        searchQuery: '',
        searchEntries: []
      })
    )
  })
}

function typeIntoInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function findButton(label: string): HTMLButtonElement | undefined {
  const buttons = Array.from(container.querySelectorAll('button'))
  return (
    buttons.find((button) => button.textContent?.trim() === label) ??
    buttons.find((button) => button.textContent?.includes(label))
  )
}

function clickButton(label: string): void {
  const button = findButton(label)
  expect(button).toBeTruthy()
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('RepositoryHostSetupsSection', () => {
  it('shows a viewing-host selector when the project has multiple settings-backed hosts', () => {
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/home/alice/orca',
      connectionId: 'openclaw 2'
    })
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        }),
        makeSetup({
          id: 'remote-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: toSshExecutionHostId('openclaw 2'),
          path: '/home/alice/orca'
        })
      ],
      sshTargetLabels: new Map([['openclaw 2', 'openclaw 2']])
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('Viewing host')
    expect(container.textContent).toContain(localHostLabel)
  })

  it('opens the selected host setup settings pane through the setup repo id', () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/home/alice/orca',
      connectionId: 'openclaw 2'
    })
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        }),
        makeSetup({
          id: 'remote-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: toSshExecutionHostId('openclaw 2'),
          path: '/home/alice/orca'
        })
      ],
      openSettingsPage,
      openSettingsTarget
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('openclaw 2')
    const openButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open'
    )
    expect(openButton).toBeTruthy()

    act(() => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'repo', repoId: 'remote-repo' })
  })

  it('removes independent setup metadata instead of opening an empty repo target', async () => {
    const deleteProjectHostSetup = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'gpu-setup',
        projectId: 'github:stablyai/orca',
        repoId: '',
        hostId: 'runtime:gpu',
        path: ''
      })
    })
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        }),
        makeSetup({
          id: 'gpu-setup',
          projectId: 'github:stablyai/orca',
          repoId: '',
          hostId: 'runtime:gpu',
          path: '',
          setupState: 'setting-up',
          setupMethod: 'provisioned'
        })
      ],
      openSettingsPage,
      openSettingsTarget,
      deleteProjectHostSetup
    })

    renderSection(localRepo)

    expect(container.textContent).toContain('Path pending')
    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove'
    )
    expect(removeButton).toBeTruthy()

    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(deleteProjectHostSetup).toHaveBeenCalledWith({ setupId: 'gpu-setup' })
    expect(openSettingsPage).not.toHaveBeenCalled()
    expect(openSettingsTarget).not.toHaveBeenCalled()
  })

  it('sets up the project on another known host from an existing folder path', async () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const setupProjectExistingFolder = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'remote-repo',
        projectId: 'github:stablyai/orca',
        repoId: 'remote-repo',
        hostId: toSshExecutionHostId('openclaw 2'),
        path: '/home/alice/orca'
      }),
      repo: makeRepo({
        id: 'remote-repo',
        displayName: 'Orca',
        path: '/home/alice/orca',
        connectionId: 'openclaw 2'
      })
    })
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        })
      ],
      sshTargetLabels: new Map([['openclaw 2', 'openclaw 2']]),
      openSettingsPage,
      openSettingsTarget,
      setupProjectExistingFolder
    })

    renderSection(localRepo)
    clickButton('Add to another host')
    clickButton('Browse folder')

    const pathInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="/path/to/project/on/host"]'
    )
    expect(pathInput).toBeTruthy()
    typeIntoInput(pathInput!, '/home/alice/orca')

    const importButton = findButton('Import')
    expect(importButton).toBeTruthy()

    await act(async () => {
      importButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setupProjectExistingFolder).toHaveBeenCalledWith({
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw%202',
      path: '/home/alice/orca',
      kind: 'git',
      displayName: 'Orca'
    })
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'repo', repoId: 'remote-repo' })
  })

  it('clones the project onto another known host from settings', async () => {
    const openSettingsPage = vi.fn()
    const openSettingsTarget = vi.fn()
    const setupProjectClone = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'remote-repo',
        projectId: 'github:stablyai/orca',
        repoId: 'remote-repo',
        hostId: toSshExecutionHostId('openclaw 2'),
        path: '/home/alice/orca'
      }),
      repo: makeRepo({
        id: 'remote-repo',
        displayName: 'Orca',
        path: '/home/alice/orca',
        connectionId: 'openclaw 2'
      })
    })
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        })
      ],
      sshTargetLabels: new Map([['openclaw 2', 'openclaw 2']]),
      openSettingsPage,
      openSettingsTarget,
      setupProjectClone
    })

    renderSection(localRepo)
    clickButton('Add to another host')
    clickButton('Clone from URL')

    const urlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Repository URL"]'
    )
    const destinationInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="/destination/on/host"]'
    )
    expect(urlInput).toBeTruthy()
    expect(destinationInput).toBeTruthy()
    typeIntoInput(urlInput!, 'https://github.com/stablyai/orca.git')
    typeIntoInput(destinationInput!, '/home/alice')

    const cloneButton = findButton('Clone')
    expect(cloneButton).toBeTruthy()

    await act(async () => {
      cloneButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setupProjectClone).toHaveBeenCalledWith({
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw%202',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/alice',
      displayName: 'Orca'
    })
    expect(openSettingsPage).toHaveBeenCalledTimes(1)
    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'repo', repoId: 'remote-repo' })
  })

  it('creates pending setup metadata for a known host without requiring a path', async () => {
    const createProjectHostSetup = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'gpu-setup',
        projectId: 'github:stablyai/orca',
        repoId: '',
        hostId: 'runtime:gpu',
        path: '',
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
    })
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        })
      ],
      settings: { activeRuntimeEnvironmentId: 'gpu' } as never,
      runtimeStatusByEnvironmentId: new Map([
        [
          'gpu',
          {
            checkedAt: 1,
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-gpu',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: [
                PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
                WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
              ]
            }
          }
        ]
      ]),
      createProjectHostSetup
    })

    renderSection(localRepo)

    clickButton('Add to another host')
    clickButton('Add host placeholder')

    const addHostButton = findButton('Add gpu')
    expect(addHostButton).toBeTruthy()

    await act(async () => {
      addHostButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createProjectHostSetup).toHaveBeenCalledWith({
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      displayName: 'Orca',
      setupState: 'not-set-up',
      setupMethod: 'provisioned'
    })
  })

  it('shows unsupported runtime hosts without enabling setup actions', async () => {
    const createProjectHostSetup = vi.fn()
    const setupProjectClone = vi.fn()
    const setupProjectExistingFolder = vi.fn()
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        })
      ],
      settings: { activeRuntimeEnvironmentId: null } as never,
      runtimeStatusByEnvironmentId: new Map([
        [
          'gpu',
          {
            checkedAt: 1,
            appVersion: '1.7.0',
            status: {
              runtimeId: 'runtime-gpu',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: []
            }
          }
        ]
      ]),
      createProjectHostSetup,
      setupProjectClone,
      setupProjectExistingFolder
    })

    renderSection(localRepo)
    clickButton('Add to another host')

    expect(container.textContent).toContain('Update Orca on this host to set up projects')
    const browseButton = findButton('Browse folder')
    const plannedButton = findButton('Add host placeholder')
    expect(browseButton?.disabled).toBe(true)
    expect(plannedButton?.disabled).toBe(true)

    await act(async () => {
      plannedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createProjectHostSetup).not.toHaveBeenCalled()
    expect(setupProjectClone).not.toHaveBeenCalled()
    expect(setupProjectExistingFolder).not.toHaveBeenCalled()
  })

  it('offers inactive runtime hosts discovered from hydrated runtime status', async () => {
    const createProjectHostSetup = vi.fn().mockResolvedValue({
      project: makeProject({ id: 'github:stablyai/orca' }),
      setup: makeSetup({
        id: 'gpu-setup',
        projectId: 'github:stablyai/orca',
        repoId: '',
        hostId: 'runtime:gpu',
        path: '',
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
    })
    const localRepo = makeRepo({
      id: 'local-repo',
      displayName: 'Orca',
      path: '/Users/alice/orca'
    })
    useAppStore.setState({
      repos: [localRepo],
      projects: [makeProject({ id: 'github:stablyai/orca' })],
      projectHostSetups: [
        makeSetup({
          id: 'local-repo',
          projectId: 'github:stablyai/orca',
          repoId: 'local-repo',
          hostId: 'local',
          path: '/Users/alice/orca'
        })
      ],
      settings: { activeRuntimeEnvironmentId: null } as never,
      runtimeStatusByEnvironmentId: new Map([
        [
          'gpu',
          {
            checkedAt: 1,
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-gpu',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: [
                PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
                WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
              ]
            }
          }
        ]
      ]),
      createProjectHostSetup
    })

    renderSection(localRepo)

    clickButton('Add to another host')
    expect(container.textContent).toContain('gpu')
    clickButton('Add host placeholder')
    const addHostButton = findButton('Add gpu')

    await act(async () => {
      addHostButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createProjectHostSetup).toHaveBeenCalledWith({
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      displayName: 'Orca',
      setupState: 'not-set-up',
      setupMethod: 'provisioned'
    })
  })
})

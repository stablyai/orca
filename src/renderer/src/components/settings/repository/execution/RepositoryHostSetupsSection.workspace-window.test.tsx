// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../../shared/worktree-runtime-capabilities'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../../../shared/runtime-session-contracts'
import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { useAppStore } from '../../../../store/index'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

let container: HTMLDivElement
let root: Root

const repo: Repo = {
  id: 'remote-repo',
  displayName: 'Orca',
  path: '/srv/orca',
  badgeColor: '#737373',
  addedAt: 100,
  kind: 'git',
  executionHostId: 'runtime:hub'
}
const project: Project = {
  id: 'github:stablyai/orca',
  displayName: 'Orca',
  badgeColor: '#737373',
  sourceRepoIds: [repo.id],
  createdAt: 100,
  updatedAt: 100
}
const setup: ProjectHostSetup = {
  id: 'hub-setup',
  projectId: project.id,
  repoId: repo.id,
  hostId: 'runtime:hub',
  runtimeOwnerEnvironmentId: 'hub',
  path: repo.path,
  displayName: repo.displayName,
  kind: 'git',
  setupState: 'ready',
  setupMethod: 'legacy-repo',
  createdAt: 100,
  updatedAt: 100
}

function makeStatus(overrides: Partial<RuntimeStatus>): RuntimeStatus {
  return {
    runtimeId: 'runtime-hub',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    desktopWindowStatus: 'available',
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: 1,
    capabilities: [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY, WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY],
    ...overrides
  }
}

function renderWithOwnerStatus(status: RuntimeStatus | null): void {
  useAppStore.setState({
    repos: [repo],
    endpointProjects: [project],
    endpointProjectHostSetups: [setup],
    runtimeStatusByEnvironmentId: new Map([['hub', { checkedAt: 1, appVersion: '1.8.0', status }]])
  })
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

// Reachable servers with missing renderer graphs previously showed every owned setup Ready (#12350).
describe('RepositoryHostSetupsSection workspace window availability', () => {
  it('flags a reachable runtime owner whose workspace window is closed instead of Ready', () => {
    renderWithOwnerStatus(
      makeStatus({
        graphStatus: 'unavailable',
        authoritativeWindowId: null,
        desktopWindowStatus: 'openable'
      })
    )

    const currentSetup = container.querySelector('[data-current="true"]')
    expect(currentSetup?.textContent).toContain('Workspace window closed')
    expect(currentSetup?.textContent).not.toContain('Ready')
    // The host is reachable — this must not be reported as a lost connection.
    expect(container.textContent).not.toContain('Disconnected')
    expect(container.textContent).toContain('Open Orca on')
  })

  it('keeps a graph-ready runtime owner Ready when it reports no desktop window', () => {
    // Headless serve can own a ready graph/openable desktop; readiness must not require a live renderer (#6844).
    renderWithOwnerStatus(makeStatus({ graphStatus: 'ready', desktopWindowStatus: 'openable' }))

    expect(container.textContent).toContain('Ready')
    expect(container.textContent).not.toContain('Workspace window closed')
    expect(container.textContent).not.toContain('Disconnected')
  })

  it('keeps an unreachable runtime owner disconnected', () => {
    renderWithOwnerStatus(null)

    expect(container.textContent).toContain('Disconnected')
    expect(container.textContent).not.toContain('Workspace window closed')
  })

  it('does not mark a transport-connected but unavailable runtime setup Ready', () => {
    useAppStore.setState({
      repos: [repo],
      endpointProjects: [project],
      endpointProjectHostSetups: [setup],
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub',
          {
            checkedAt: 1,
            status: null,
            remoteControl: {
              state: 'ready',
              pendingRequestCount: 0,
              subscriptionCount: 0,
              reconnectAttempt: 0,
              lastConnectedAt: 1,
              lastClose: null,
              lastError: null
            }
          }
        ]
      ])
    })
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

    const currentSetup = container.querySelector('[data-current="true"]')
    expect(currentSetup?.textContent).toContain('Unknown')
    expect(currentSetup?.textContent).not.toContain('Ready')
  })

  it('does not call a setup Ready when the owner control channel closed with an error', () => {
    renderWithOwnerStatus(
      makeStatus({
        remoteControl: {
          state: 'closed',
          pendingRequestCount: 0,
          subscriptionCount: 0,
          reconnectAttempt: 0,
          lastConnectedAt: null,
          lastClose: null,
          lastError: 'Connection closed'
        }
      })
    )

    expect(container.textContent).toContain('Disconnected')
    expect(container.textContent).not.toContain('Workspace window closed')
  })
})

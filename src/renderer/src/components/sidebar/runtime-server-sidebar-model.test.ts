import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  buildRuntimeServerEntries,
  getRuntimeServerProjectActivationWorktree,
  getRuntimeServerProjectLabel,
  type RuntimeServerProjectState
} from './runtime-server-sidebar-model'

function repo(id: string, displayName: string): Repo {
  return {
    id,
    path: `/repos/${displayName}`,
    displayName,
    badgeColor: '#737373',
    addedAt: 1
  }
}

function environment(
  id: string,
  name: string,
  endpoint = `ws://${id}.tailnet.example:6768`
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint
      }
    ]
  }
}

function environmentWithPreferredSecondEndpoint(): PublicKnownRuntimeEnvironment {
  return {
    id: 'mini-2',
    name: 'mini2',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'preferred',
    endpoints: [
      {
        id: 'fallback',
        kind: 'websocket',
        label: 'Fallback',
        endpoint: 'ws://fallback.example:6768'
      },
      {
        id: 'preferred',
        kind: 'websocket',
        label: 'Preferred',
        endpoint: 'ws://preferred.example:6768'
      }
    ]
  }
}

function environmentWithoutEndpoints(): PublicKnownRuntimeEnvironment {
  return {
    id: 'offline',
    name: 'Offline',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'missing',
    endpoints: []
  }
}

function worktree(id: string, isMainWorktree = false): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/repos/project/${id}`,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

describe('runtime server sidebar model', () => {
  it('builds local and remote entries with the selected runtime marked active', () => {
    const remoteState: RuntimeServerProjectState = {
      status: 'ready',
      repos: [repo('remote-repo', 'Remote project')],
      error: null
    }

    const entries = buildRuntimeServerEntries({
      activeRuntimeEnvironmentId: 'mini-1',
      environments: [environment('mini-1', 'mini1')],
      localProjects: {
        status: 'ready',
        repos: [repo('local-repo', 'Local project')],
        error: null
      },
      remoteProjectsByEnvironmentId: new Map([['mini-1', remoteState]])
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: null, label: 'Local', active: false, kind: 'local' })
    expect(entries[1]).toMatchObject({
      id: 'mini-1',
      label: 'mini1',
      active: true,
      kind: 'remote',
      endpoint: 'ws://mini-1.tailnet.example:6768',
      projects: remoteState
    })
  })

  it('defaults unfetched remote project lists to idle state', () => {
    const entries = buildRuntimeServerEntries({
      activeRuntimeEnvironmentId: null,
      environments: [environment('mini-1', 'mini1'), environment('mini-2', 'mini2')],
      localProjects: { status: 'ready', repos: [], error: null },
      remoteProjectsByEnvironmentId: new Map()
    })

    expect(entries[0]?.active).toBe(true)
    expect(entries[1]?.projects).toEqual({ status: 'idle', repos: [], error: null })
    expect(entries[2]?.projects).toEqual({ status: 'idle', repos: [], error: null })
    expect(entries[1]?.projects).not.toBe(entries[2]?.projects)
  })

  it('displays the preferred runtime endpoint when it is not first', () => {
    const entries = buildRuntimeServerEntries({
      activeRuntimeEnvironmentId: null,
      environments: [environmentWithPreferredSecondEndpoint()],
      localProjects: { status: 'ready', repos: [], error: null },
      remoteProjectsByEnvironmentId: new Map()
    })

    expect(entries[1]).toMatchObject({
      kind: 'remote',
      endpoint: 'ws://preferred.example:6768'
    })
  })

  it('uses a null endpoint for runtime servers without configured endpoints', () => {
    const entries = buildRuntimeServerEntries({
      activeRuntimeEnvironmentId: null,
      environments: [environmentWithoutEndpoints()],
      localProjects: { status: 'ready', repos: [], error: null },
      remoteProjectsByEnvironmentId: new Map()
    })

    expect(entries[1]).toMatchObject({
      kind: 'remote',
      endpoint: null
    })
  })

  it('formats project state labels for counts, loading, and errors', () => {
    expect(getRuntimeServerProjectLabel({ status: 'idle', repos: [], error: null })).toBe(
      'Not loaded'
    )
    expect(
      getRuntimeServerProjectLabel({
        status: 'ready',
        repos: [repo('one', 'One')],
        error: null
      })
    ).toBe('1 project')
    expect(
      getRuntimeServerProjectLabel({
        status: 'ready',
        repos: [repo('one', 'One'), repo('two', 'Two')],
        error: null
      })
    ).toBe('2 projects')
    expect(getRuntimeServerProjectLabel({ status: 'loading', repos: [], error: null })).toBe(
      'Loading projects...'
    )
    expect(getRuntimeServerProjectLabel({ status: 'error', repos: [], error: 'offline' })).toBe(
      'offline'
    )
    expect(getRuntimeServerProjectLabel({ status: 'error', repos: [], error: '' })).toBe(
      'Failed to load projects'
    )
  })

  it('prefers the main workspace when activating a server project', () => {
    const child = worktree('child')
    const main = worktree('main', true)

    expect(getRuntimeServerProjectActivationWorktree([child, main])).toBe(main)
    expect(getRuntimeServerProjectActivationWorktree([child])).toBe(child)
    expect(getRuntimeServerProjectActivationWorktree([])).toBeNull()
  })
})

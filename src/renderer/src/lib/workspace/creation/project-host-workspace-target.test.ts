import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { resolveWorkspaceCreationTarget } from './project-host-workspace-target'

const REMOTE = 'runtime:devbox'
const PROJECT_ID = 'github:acme/myapp'

function repo(id: string, hostId: string, path: string): Repo {
  return {
    id,
    path,
    displayName: 'myapp',
    kind: 'git',
    connectionId: null,
    executionHostId: hostId
  } as unknown as Repo
}

function setup(id: string, repoId: string, hostId: string, path: string): ProjectHostSetup {
  return {
    id,
    projectId: PROJECT_ID,
    hostId,
    repoId,
    path,
    displayName: 'myapp',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  } as unknown as ProjectHostSetup
}

const project: Project = {
  id: PROJECT_ID,
  displayName: 'myapp',
  badgeColor: '#888888',
  sourceRepoIds: ['repo-local', 'repo-remote'],
  createdAt: 1,
  updatedAt: 1
} as unknown as Project

const localRepo = repo('repo-local', 'local', '/Users/me/src/myapp')
const remoteRepo = repo('repo-remote', REMOTE, '/home/me/myapp')
const localSetup = setup('setup-local', 'repo-local', 'local', '/Users/me/src/myapp')
const remoteSetup = setup('setup-remote', 'repo-remote', REMOTE, '/home/me/myapp')

function resolve(args: Partial<Parameters<typeof resolveWorkspaceCreationTarget>[0]> = {}) {
  return resolveWorkspaceCreationTarget({
    eligibleRepos: [localRepo, remoteRepo],
    projects: [project],
    projectHostSetups: [remoteSetup, localSetup],
    focusedHostScope: 'all',
    ...args
  })
}

describe('resolveWorkspaceCreationTarget default host', () => {
  it('prefers Local when array order lists the remote setup first', () => {
    const resolution = resolve({ projectId: PROJECT_ID })
    expect(resolution.status).toBe('ready')
    expect(resolution.status === 'ready' ? resolution.target.hostId : null).toBe('local')
  })

  it('prefers Local for same-id twins even when the remote setup is listed first', () => {
    const twins = [
      repo('repo-myapp', REMOTE, '/home/me/myapp'),
      repo('repo-myapp', 'local', '/Users/me/src/myapp')
    ]
    const twinSetups = [
      setup('s-r', 'repo-myapp', REMOTE, '/home/me/myapp'),
      setup('s-l', 'repo-myapp', 'local', '/Users/me/src/myapp')
    ]
    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: twins,
      projectHostSetups: twinSetups,
      activeRepoId: 'repo-myapp',
      focusedHostScope: 'all'
    })
    expect(resolution.status).toBe('ready')
    expect(resolution.status === 'ready' ? resolution.target.hostId : null).toBe('local')
  })

  it('prefers the active workspace host over Local for same-id twins', () => {
    const twins = [
      repo('repo-myapp', REMOTE, '/home/me/myapp'),
      repo('repo-myapp', 'local', '/Users/me/src/myapp')
    ]
    const twinSetups = [
      setup('s-r', 'repo-myapp', REMOTE, '/home/me/myapp'),
      setup('s-l', 'repo-myapp', 'local', '/Users/me/src/myapp')
    ]
    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: twins,
      projectHostSetups: twinSetups,
      activeRepoId: 'repo-myapp',
      activeWorkspaceHostId: REMOTE,
      focusedHostScope: 'all'
    })
    expect(resolution.status).toBe('ready')
    expect(resolution.status === 'ready' ? resolution.target.hostId : null).toBe(REMOTE)
  })

  it('keeps an explicit host selection authoritative', () => {
    const resolution = resolve({ projectId: PROJECT_ID, hostId: REMOTE })
    expect(resolution.status === 'ready' ? resolution.target.hostId : null).toBe(REMOTE)
  })
})

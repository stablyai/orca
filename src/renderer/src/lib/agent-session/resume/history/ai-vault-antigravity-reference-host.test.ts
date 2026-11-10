import { describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { resolveAiVaultSessionLaunchTarget } from '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-launch-target'
import type { buildAiVaultResumeStartupForWorktree } from './ai-vault-resume-command'
import { getAiVaultResumeWorkspaceWslDistro } from './ai-vault-resume-shell'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'

vi.mock('@/lib/workspace/creation/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

type State = Parameters<typeof buildAiVaultResumeStartupForWorktree>[0]['state']
const windowsFile = 'C:/Users/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'
const linuxFile = '/home/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'
const debianFile =
  '//wsl.localhost/Debian/home/example/.gemini/antigravity-ide/brain/copied-id/transcript_full.jsonl'

function stateFor(host: ExecutionHostId, distro?: string): State {
  const worktree = makeWorktree({
    id: 'repo::workspace',
    repoId: 'repo',
    hostId: host,
    path: distro ? `//wsl.localhost/${distro}/home/example/project` : 'C:/project'
  })
  return {
    activeRepoId: 'repo',
    activeWorktreeId: worktree.id,
    detectedWorktreesByRepo: {},
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    folderWorkspaces: [],
    projectGroups: [],
    settings: null,
    repos: [
      {
        id: 'repo',
        path: worktree.path,
        displayName: 'project',
        badgeColor: '',
        addedAt: 0,
        projectGroupId: 'group-1',
        executionHostId: host
      }
    ],
    projects: [
      {
        id: 'repo',
        displayName: 'project',
        badgeColor: '',
        sourceRepoIds: ['repo'],
        createdAt: 0,
        updatedAt: 0,
        localWindowsRuntimePreference: distro ? { kind: 'wsl', distro } : { kind: 'windows-host' }
      }
    ],
    worktreesByRepo: { repo: [worktree] }
  }
}

describe('Antigravity transcript reference ownership', () => {
  it('applies the same confinement to folder workspaces', () => {
    const state = stateFor('local')
    state.activeRepoId = null
    state.repos = []
    state.projects = []
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({ folderPath: '//wsl.localhost/Debian/home/example/project' })
    ]
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: 'folder:folder-1',
        targetState: state
      }).status
    ).toBe('ready')
    state.folderWorkspaces[0].folderPath = '//wsl.localhost/Ubuntu/home/example/project'
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: 'folder:folder-1',
        targetState: state
      }).status
    ).toBe('unsupported')
  })

  it('lets an explicit folder project runtime override the UNC path distro', () => {
    const state = stateFor('local', 'Ubuntu')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({
        folderPath: '//wsl.localhost/Debian/home/example/project'
      })
    ]
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBe('Ubuntu')
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: debianFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('unsupported')
  })

  it('does not substitute a local project runtime into an SSH folder launch', () => {
    const state = stateFor('ssh:owner', 'Debian')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [
      makeFolderWorkspace({
        folderPath: '/remote/non-git-folder',
        executionHostId: 'ssh:owner'
      })
    ]
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBeNull()
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: linuxFile,
        sessionExecutionHostId: 'ssh:owner',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('ready')
  })

  it('refuses local references while the project runtime requires repair', () => {
    const state = stateFor('local')
    state.projects[0].localWindowsRuntimePreference = { kind: 'inherit-global' }
    state.settings = createGlobalSettingsFixture({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
    })
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBeUndefined()
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: windowsFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('unsupported')
  })

  it('refuses references when a folder has multiple possible owning projects', () => {
    const state = stateFor('local', 'Ubuntu')
    state.activeWorktreeId = 'folder:folder-1'
    state.folderWorkspaces = [makeFolderWorkspace({ folderPath: 'C:/project/folder' })]
    state.repos = [
      ...state.repos,
      {
        id: 'second',
        path: 'C:/second',
        projectGroupId: 'group-1',
        displayName: 'second',
        badgeColor: '',
        addedAt: 0
      }
    ]
    expect(getAiVaultResumeWorkspaceWslDistro(state, state.activeWorktreeId)).toBeUndefined()
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: windowsFile,
        sessionExecutionHostId: 'local',
        activeWorktreeId: state.activeWorktreeId,
        targetState: state
      }).status
    ).toBe('unsupported')
  })
})

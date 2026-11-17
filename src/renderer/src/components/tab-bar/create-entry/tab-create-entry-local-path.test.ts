import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project/groups/project-group-types'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'

import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useAppStore } from '@/store/index'

import * as metadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import * as rpcCall from '@/runtime/rpc/calls/runtime-rpc-call'
import * as artifactGrant from '@/runtime/files/grants/runtime-terminal-artifact-grant'
import { openTabBarEntry } from './tab-create-entry-action'
import {
  getTabEntryAbsolutePathPolicy,
  getTabEntryAllowAbsolutePaths
} from './tab-create-entry-local-path'

const initialState = useAppStore.getInitialState()

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-local',
    projectGroupId: 'group-local',
    name: 'Local folder',
    folderPath: '/Users/me/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-local',
    name: 'Local group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('getTabEntryAllowAbsolutePaths', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  it('opens existing HTML as source in a local folder workspace', async () => {
    const folder = makeFolderWorkspace()
    const worktreeId = folderWorkspaceKey(folder.id)
    useAppStore.setState({
      folderWorkspaces: [folder],
      projectGroups: [makeProjectGroup()],
      repos: []
    })
    vi.spyOn(metadata, 'statRuntimePath').mockResolvedValue({
      size: 1,
      isDirectory: false,
      mtime: 1
    })

    await openTabBarEntry({
      query: 'report.html',
      worktreeId,
      groupId: 'group-local',
      fileList: { files: ['report.html'], loading: false, loadError: null }
    })

    expect(useAppStore.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/Users/me/folder/report.html',
        relativePath: 'report.html',
        worktreeId,
        language: 'html',
        mode: 'edit'
      })
    ])
    expect(useAppStore.getState().browserTabsByWorktree[worktreeId] ?? []).toHaveLength(0)
  })

  it('opens an external absolute file on a paired Orca server through a host grant', async () => {
    const repo = {
      ...TEST_REPO,
      id: 'repo-remote',
      path: '/srv/repo',
      executionHostId: 'runtime:env-1' as const
    }
    const worktree = makeWorktree({
      id: 'repo-remote::/srv/repo',
      repoId: repo.id,
      path: '/srv/repo'
    })
    const env = publicRuntimeEnvironment({ id: 'env-1' })
    const status = connectedRuntimeStatus('env-1', 1)
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      runtimeEnvironments: [env],
      runtimeEnvironmentCatalogHydrated: true,
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          { ...status, status: status.status && { ...status.status, hostPlatform: 'linux' } }
        ]
      ])
    })

    expect(getTabEntryAbsolutePathPolicy(useAppStore.getState(), worktree.id)).toEqual({
      allowAbsolutePaths: true,
      platform: 'posix'
    })

    vi.spyOn(artifactGrant, 'hostSavesGrantedFiles').mockResolvedValue(true)
    const rpcSpy = vi.spyOn(rpcCall, 'callRuntimeRpc').mockResolvedValue({
      worktree: worktree.id,
      relativePath: null,
      absolutePath: '/tmp/orca-external-file-repro.txt',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: '/tmp/orca-external-file-repro.txt',
        grantId: 'grant-1'
      }
    })

    await openTabBarEntry({
      query: '/tmp/orca-external-file-repro.txt',
      worktreeId: worktree.id,
      groupId: 'group-remote',
      fileList: { files: [], loading: false, loadError: null }
    })

    expect(rpcSpy).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'files.resolveTerminalPath',
      { worktree: `id:${worktree.id}`, pathText: '/tmp/orca-external-file-repro.txt' }
    )
    expect(useAppStore.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/tmp/orca-external-file-repro.txt',
        relativePath: '/tmp/orca-external-file-repro.txt',
        worktreeId: worktree.id,
        runtimeEnvironmentId: 'env-1',
        terminalArtifactGrantId: 'grant-1',
        mode: 'edit'
      })
    ])
  })

  it('opens an in-workspace absolute file on a paired Orca server using its relative path', async () => {
    const repo = {
      ...TEST_REPO,
      id: 'repo-remote',
      path: '/srv/repo',
      executionHostId: 'runtime:env-1' as const
    }
    const worktree = makeWorktree({
      id: 'repo-remote::/srv/repo',
      repoId: repo.id,
      path: '/srv/repo'
    })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'env-1' })],
      runtimeEnvironmentCatalogHydrated: true
    })

    vi.spyOn(rpcCall, 'callRuntimeRpc').mockResolvedValue({
      worktree: worktree.id,
      relativePath: 'src/main.ts',
      absolutePath: '/srv/repo/src/main.ts',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'worktree-file',
        provider: 'local',
        relativePath: 'src/main.ts',
        absolutePath: '/srv/repo/src/main.ts'
      }
    })

    await openTabBarEntry({
      query: '/srv/repo/src/main.ts',
      worktreeId: worktree.id,
      groupId: 'group-remote',
      fileList: { files: [], loading: false, loadError: null }
    })

    expect(useAppStore.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/srv/repo/src/main.ts',
        relativePath: 'src/main.ts',
        worktreeId: worktree.id,
        runtimeEnvironmentId: 'env-1',
        mode: 'edit'
      })
    ])
    expect(useAppStore.getState().openFiles[0]?.terminalArtifactGrantId).toBeUndefined()
  })

  it('allows absolute paths in paired Orca server folder workspaces but blocks SSH workspaces', () => {
    const remoteFolder = makeFolderWorkspace({
      id: 'folder-remote',
      projectGroupId: 'group-remote',
      folderPath: '/srv/folder',
      executionHostId: 'runtime:env-1'
    })
    const sshRepo = { ...TEST_REPO, id: 'repo-ssh', path: '/srv/ssh', connectionId: 'ssh-box' }
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/srv/ssh',
      repoId: sshRepo.id,
      path: '/srv/ssh'
    })
    useAppStore.setState({
      folderWorkspaces: [remoteFolder],
      projectGroups: [makeProjectGroup({ id: 'group-remote', executionHostId: 'runtime:env-1' })],
      repos: [sshRepo],
      worktreesByRepo: { [sshRepo.id]: [sshWorktree] },
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'env-1' })],
      runtimeEnvironmentCatalogHydrated: true
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), folderWorkspaceKey(remoteFolder.id))
    ).toBe(true)
    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), sshWorktree.id)).toBe(false)
  })
})

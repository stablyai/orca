// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'

import {
  listRuntimeFilesMock,
  cancelRuntimeFileListMock,
  searchRuntimeFilePathsMock
} from './__mocks__/quick-open-runtime-file-client'

export const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

export function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/srv/platform',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath: '/srv/platform',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function makeRemoteWorktree(): Worktree {
  return {
    id: 'wt-remote',
    repoId: 'repo-remote',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1',
    path: '/srv/remote',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Remote',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

export function seedRemoteWorktree(): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      ...initialAppState.settings,
      activeRuntimeEnvironmentId: 'env-1'
    },
    repos: [],
    worktreesByRepo: { 'repo-remote': [makeRemoteWorktree()] }
  })
}

export function HookProbe({
  enabled,
  states,
  query,
  worktreeId,
  recentPaths
}: {
  enabled: boolean
  states: RuntimeFileListState[]
  query?: string
  recentPaths?: readonly string[]
  worktreeId: string | null
}): null {
  // Record every render before effects can settle ownership changes.
  states.push(useRuntimeFileListForWorktree({ enabled, worktreeId, query, recentPaths }))
  return null
}

export async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

export async function waitForListRuntimeFilesCall(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushEffects()
    if (listRuntimeFilesMock.mock.calls.length > 0) {
      return
    }
  }
  throw new Error('listRuntimeFiles was not called')
}

export async function renderProbe(args: {
  enabled: boolean
  states: RuntimeFileListState[]
  query?: string
  recentPaths?: readonly string[]
  worktreeId: string | null
}): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, args))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  useAppStore.setState(initialAppState, true)
})

export { listRuntimeFilesMock, cancelRuntimeFileListMock, searchRuntimeFilePathsMock }

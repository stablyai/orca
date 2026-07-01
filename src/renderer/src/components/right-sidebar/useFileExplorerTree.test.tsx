// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { FileExplorerRoot } from './file-explorer-types'
import { FILE_EXPLORER_MULTI_ROOT_CACHE_KEY, useFileExplorerTree } from './useFileExplorerTree'
import { getDefaultSettings } from '../../../../shared/constants'

const runtimeFileMocks = vi.hoisted(() => ({
  readRuntimeDirectory: vi.fn(),
  statRuntimePath: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeDirectory: runtimeFileMocks.readRuntimeDirectory,
  statRuntimePath: runtimeFileMocks.statRuntimePath
}))

const initialAppState = useAppStore.getInitialState()
const EMPTY_EXPANDED = new Set<string>()
const hookRoots: Root[] = []
let latestTree: ReturnType<typeof useFileExplorerTree> | null = null

type CompactRuntimeContext = {
  runtimeEnvironmentId: string | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId: string | undefined
}

function HookProbe({
  roots,
  expanded = EMPTY_EXPANDED
}: {
  roots: readonly FileExplorerRoot[]
  expanded?: Set<string>
}): null {
  latestTree = useFileExplorerTree('/remote/api', expanded, 'api-wt', roots)
  return null
}

async function renderHookProbe(roots: readonly FileExplorerRoot[]): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  hookRoots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { roots }))
  })
}

function tree(): ReturnType<typeof useFileExplorerTree> {
  if (!latestTree) {
    throw new Error('hook has not rendered')
  }
  return latestTree
}

function runtimeContexts(): RuntimeFileOperationArgs[] {
  return runtimeFileMocks.readRuntimeDirectory.mock.calls.map(
    ([context]) => context as RuntimeFileOperationArgs
  )
}

function compactRuntimeContexts(): CompactRuntimeContext[] {
  return runtimeContexts().map((context) => ({
    runtimeEnvironmentId: context.settings?.activeRuntimeEnvironmentId,
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    connectionId: context.connectionId
  }))
}

const apiRoot: FileExplorerRoot = {
  id: 'api-wt',
  name: 'api',
  path: '/remote/api',
  worktreeId: 'api-wt',
  repoId: 'api',
  connectionId: 'ssh-api',
  runtimeEnvironmentId: null,
  isActive: true
}

const webRoot: FileExplorerRoot = {
  id: 'web-wt',
  name: 'web',
  path: '/Users/me/web',
  worktreeId: 'web-wt',
  repoId: 'web',
  connectionId: null,
  runtimeEnvironmentId: 'env-web',
  isActive: false
}

describe('useFileExplorerTree multi-root routing', () => {
  beforeEach(() => {
    latestTree = null
    runtimeFileMocks.readRuntimeDirectory.mockReset()
    runtimeFileMocks.statRuntimePath.mockReset()
    runtimeFileMocks.readRuntimeDirectory.mockResolvedValue([])
    runtimeFileMocks.statRuntimePath.mockResolvedValue({ isDirectory: false })
    useAppStore.setState({
      ...initialAppState,
      repos: [
        {
          id: 'api',
          path: '/remote/api',
          displayName: 'api',
          connectionId: 'ssh-api',
          addedAt: 1
        },
        {
          id: 'web',
          path: '/Users/me/web',
          displayName: 'web',
          addedAt: 1
        }
      ] as never,
      worktreesByRepo: {
        api: [
          {
            id: 'api-wt',
            repoId: 'api',
            path: '/remote/api',
            hostId: 'ssh:ssh-api'
          }
        ],
        web: [
          {
            id: 'web-wt',
            repoId: 'web',
            path: '/Users/me/web',
            hostId: 'runtime:env-web'
          }
        ]
      } as never,
      settings: {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'focused-env'
      }
    })
  })

  afterEach(() => {
    hookRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('loads each workspace root with its own worktree, path, connection, and runtime owner', async () => {
    await renderHookProbe([apiRoot, webRoot])

    await act(async () => {
      await tree().loadDir(FILE_EXPLORER_MULTI_ROOT_CACHE_KEY, -1, { force: true })
      await tree().loadDir('/remote/api', 0, { force: true })
      await tree().loadDir('/Users/me/web', 0, { force: true })
    })

    expect(runtimeFileMocks.readRuntimeDirectory).toHaveBeenCalledTimes(2)
    expect(compactRuntimeContexts()).toEqual([
      {
        runtimeEnvironmentId: null,
        worktreeId: 'api-wt',
        worktreePath: '/remote/api',
        connectionId: 'ssh-api'
      },
      {
        runtimeEnvironmentId: 'env-web',
        worktreeId: 'web-wt',
        worktreePath: '/Users/me/web',
        connectionId: undefined
      }
    ])
  })
})

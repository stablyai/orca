import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import { handleInternalTerminalFileDrop, handleTerminalFileDrop } from './terminal-drop-handler'

const mocks = vi.hoisted(() => {
  const worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      path: string
      hostId: ExecutionHostId
      runtimeOwnerEnvironmentId?: string
    }[]
  > = {}
  const folderWorkspaces: {
    id: string
    projectGroupId: string
    folderPath: string
    executionHostId: ExecutionHostId
  }[] = []
  return {
    state: {
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [],
      worktreesByRepo,
      detectedWorktreesByRepo: {},
      folderWorkspaces,
      sshConnectionStates: new Map([['target-1', { connectionGeneration: 99 }]]),
      sshStateByEnvironment: new Map([
        [
          'owner-runtime',
          { connectionStates: new Map([['target-1', { connectionGeneration: 1 }]]) }
        ]
      ])
    },
    importPaths: vi.fn(),
    toastError: vi.fn()
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: mocks.toastError, message: vi.fn() }
}))

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.worktreesByRepo = {
    local: [{ id: 'wt-1', repoId: 'local', path: 'C:\\wrong-local', hostId: 'local' }],
    remote: [
      {
        id: 'wt-1',
        repoId: 'remote',
        path: '/owner/workspace',
        hostId: 'runtime:owner-runtime',
        runtimeOwnerEnvironmentId: 'owner-runtime'
      }
    ]
  }
  mocks.state.folderWorkspaces = [
    {
      id: 'notes',
      projectGroupId: 'local',
      folderPath: 'C:\\wrong-local',
      executionHostId: 'local'
    },
    {
      id: 'notes',
      projectGroupId: 'remote',
      folderPath: '/owner/workspace',
      executionHostId: 'runtime:owner-runtime'
    }
  ]
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/owner/workspace/.orca/drops/file.txt' }]
  })
})

async function drop(lane: string, workspaceId: string, executionHostId: ExecutionHostId) {
  const sendInput = vi.fn(() => true)
  const pane = { id: 1, leafId: 'leaf-1', terminal: { focus: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Drops only enumerate this pane and capture its identity.
  const manager = { getPanes: () => [pane], getActivePane: () => pane } as never
  const transport = {
    sendInput,
    getPtyId: () => 'runtime-pty-1',
    isConnected: () => true,
    getExecutionHostId: () => executionHostId,
    getRuntimeEnvironmentId: () => 'owner-runtime'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The transport supplies every method used by these drop handlers.
  const paneTransports = new Map([[1, transport]]) as never
  const args = {
    manager,
    paneTransports,
    worktreeId: workspaceId,
    tabId: 'tab-1',
    cwd: '/wrong-cwd'
  }
  let result: Awaited<ReturnType<typeof handleInternalTerminalFileDrop>> | undefined
  if (lane === 'native') {
    await handleTerminalFileDrop({
      ...args,
      pane: pane,
      paths: ['/client/file.txt']
    })
  } else {
    result = await handleInternalTerminalFileDrop({
      ...args,
      paneLeafId: 'leaf-1',
      dataTransfer: {
        getData: (type) =>
          type === WORKSPACE_FILE_DRAG_SOURCE_MIME
            ? JSON.stringify({
                version: 1,
                workspaceId: 'wt-1',
                runtimeEnvironmentId: 'owner-runtime',
                executionHostId:
                  executionHostId === 'local' ? 'runtime:owner-runtime' : executionHostId
              })
            : type === WORKSPACE_FILE_PATHS_MIME
              ? encodeWorkspaceFilePaths(['/owner/workspace/file with spaces.txt'])
              : ''
      }
    })
  }
  return { sendInput, result, transport }
}

describe.each(['native', 'internal'])('%s runtime terminal catalog ownership', (lane) => {
  it.each(['worktree', 'folder', 'ssh'])(
    'resolves a runtime %s without choosing a local duplicate',
    async (kind) => {
      const executionHostId = kind === 'ssh' ? 'ssh:target-1' : 'local'
      if (kind === 'ssh') {
        mocks.state.worktreesByRepo.remote[0].hostId = 'ssh:target-1'
        mocks.state.worktreesByRepo.local.push({
          id: 'wt-1',
          repoId: 'local',
          path: 'C:\\wrong-direct-ssh',
          hostId: 'ssh:target-1'
        })
        mocks.state.worktreesByRepo.otherRuntime = [
          {
            id: 'wt-1',
            repoId: 'other',
            path: 'C:\\wrong-runtime',
            hostId: 'ssh:target-1',
            runtimeOwnerEnvironmentId: 'other-runtime'
          }
        ]
      }
      const workspaceId = kind === 'folder' ? 'folder:notes' : 'wt-1'
      const { sendInput, result, transport } = await drop(lane, workspaceId, executionHostId)
      expect(transport.getExecutionHostId()).toBe(executionHostId)
      expect(transport.getRuntimeEnvironmentId()).toBe('owner-runtime')
      if (lane === 'native') {
        expect(mocks.importPaths).toHaveBeenCalledExactlyOnceWith(
          {
            settings: { activeRuntimeEnvironmentId: 'owner-runtime' },
            worktreeId: workspaceId,
            worktreePath: '/owner/workspace',
            expectedExecutionHostId: executionHostId,
            expectedSshTargetId: kind === 'ssh' ? 'target-1' : undefined,
            expectedSshConnectionGeneration: kind === 'ssh' ? 1 : undefined
          },
          ['/client/file.txt'],
          '/owner/workspace/.orca/drops',
          { assertCurrent: expect.any(Function) }
        )
        expect(sendInput).toHaveBeenCalledExactlyOnceWith(
          '/owner/workspace/.orca/drops/file.txt ',
          'driving'
        )
      } else {
        expect(result).toEqual({ status: 'pasted', pathCount: 1 })
        expect(sendInput).toHaveBeenCalledExactlyOnceWith(
          "'/owner/workspace/file with spaces.txt' ",
          'driving'
        )
        expect(mocks.importPaths).not.toHaveBeenCalled()
      }
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it.each(['missing-owner', 'wrong-environment', 'wrong-ssh-target'])(
    'refuses %s instead of borrowing a catalog root',
    async (mismatch) => {
      if (mismatch === 'missing-owner') {
        delete mocks.state.worktreesByRepo.remote
      } else if (mismatch === 'wrong-environment') {
        mocks.state.worktreesByRepo.remote[0].hostId = 'ssh:target-1'
        mocks.state.worktreesByRepo.remote[0].runtimeOwnerEnvironmentId = 'other-runtime'
      } else {
        mocks.state.worktreesByRepo.remote[0].hostId = 'ssh:other-target'
      }
      const { sendInput, result } = await drop(
        lane,
        'wt-1',
        mismatch === 'missing-owner' ? 'local' : 'ssh:target-1'
      )
      expect(sendInput).not.toHaveBeenCalled()
      expect(mocks.importPaths).not.toHaveBeenCalled()
      if (lane === 'native') {
        expect(mocks.toastError).toHaveBeenCalledWith('Worktree path not available.')
      } else {
        expect(result).toEqual({ status: 'ignored', reason: 'worktree-unavailable' })
      }
    }
  )
})

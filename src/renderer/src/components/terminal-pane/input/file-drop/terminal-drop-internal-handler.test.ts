// @vitest-environment happy-dom
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const worktreesByRepo: Record<
    string,
    { id: string; repoId: string; path: string; hostId?: string | null }[]
  > = {
    repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/remote/repo', hostId: 'runtime:env-1' }]
  }
  return {
    toastLoading: vi.fn(() => 'toast-1'),
    toastDismiss: vi.fn(),
    toastError: vi.fn(),
    importExternalPathsToRuntime: vi.fn(),
    resolveDroppedPathsForAgent: vi.fn(),
    recordTerminalUserInputForLeaf: vi.fn(),
    storeState: {
      activeRepoId: 'repo1',
      activeWorktreeId: 'wt-1',
      settings: { activeRuntimeEnvironmentId: 'env-1' as string | null },
      projects: [
        {
          id: 'repo1',
          localWindowsRuntimePreference: { kind: 'inherit-global' as const }
        }
      ] as {
        id: string
        localWindowsRuntimePreference:
          | { kind: 'inherit-global' }
          | { kind: 'windows-host' }
          | { kind: 'wsl'; distro: string | null }
      }[],
      repos: [
        {
          id: 'repo1',
          connectionId: null as string | null,
          path: '/remote/repo',
          executionHostId: 'runtime:env-1' as string | null
        }
      ],
      worktreesByRepo,
      sshConnectionStates: new Map<string, { remotePlatform?: NodeJS.Platform }>()
    }
  }
})

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    message: vi.fn()
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/files/imports/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importExternalPathsToRuntime
}))

vi.mock('@/lib/workspace/creation/new-workspace', () => ({
  CLIENT_PLATFORM: 'win32'
}))

vi.mock('../terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'

function sameHostDragData(paths: string[]) {
  const source = JSON.stringify({
    version: 1,
    workspaceId: 'wt-1',
    executionHostId: mocks.storeState.repos[0]?.executionHostId ?? 'local'
  })
  return (type: string): string =>
    type === WORKSPACE_FILE_DRAG_SOURCE_MIME
      ? source
      : type === WORKSPACE_FILE_PATHS_MIME
        ? encodeWorkspaceFilePaths(paths)
        : ''
}

function createTerminalTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  const host = parseExecutionHostId(mocks.storeState.repos[0]?.executionHostId)
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true),
    getExecutionHostId: () => (host?.kind === 'runtime' ? 'local' : (host?.id ?? 'local')),
    getRuntimeEnvironmentId: () => (host?.kind === 'runtime' ? host.environmentId : null)
  }
}

describe('handleInternalTerminalFileDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
    mocks.storeState.repos = [
      { id: 'repo1', connectionId: null, path: '/repo', executionHostId: 'local' }
    ]
    mocks.storeState.worktreesByRepo = {
      repo1: [
        {
          id: 'wt-1',
          repoId: 'repo1',
          path: '/repo',
          hostId: parseExecutionHostId(mocks.storeState.repos[0]?.executionHostId)?.id ?? 'local'
        }
      ]
    }
    mocks.storeState.sshConnectionStates = new Map()
  })

  it('stops internal file-drop paste when the target transport changes between paths', async () => {
    const sendInput = vi.fn(() => true)
    const replacementSendInput = vi.fn(() => true)
    const paneTransports = new Map<number, ReturnType<typeof createTerminalTransport>>()
    const replacementTransport = createTerminalTransport(replacementSendInput, 'pty-2')
    const sendInputAccepted = vi.fn(async () => {
      paneTransports.set(1, replacementTransport)
      return true
    })
    const focus = vi.fn()
    const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
    const manager = {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
    const originalTransport = createTerminalTransport(sendInput, 'pty-1', sendInputAccepted)
    paneTransports.set(1, originalTransport)

    const result = await handleInternalTerminalFileDrop({
      manager: manager as never,
      paneTransports: paneTransports as never,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      cwd: undefined,
      paneLeafId: 'leaf-1',
      dataTransfer: {
        getData: sameHostDragData(['/repo/a.ts', '/repo/b.ts'])
      }
    })

    expect(result).toEqual({ status: 'cancelled', reason: 'target-stale', pathCount: 1 })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith('/repo/a.ts ', 'driving', {
      signal: expect.any(AbortSignal)
    })
    expect(sendInput).not.toHaveBeenCalled()
    expect(replacementSendInput).not.toHaveBeenCalled()
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

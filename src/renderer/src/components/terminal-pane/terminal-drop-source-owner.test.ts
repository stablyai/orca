// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '@/lib/workspace-file-drag'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'

const mocks = vi.hoisted(() => ({ write: vi.fn(), error: vi.fn(), activity: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('./terminal-drop-worktree-path', () => ({ resolveTerminalDropWorktreePath: () => '/repo' }))
vi.mock('./terminal-drop-shell', () => ({
  resolveTerminalDropTargetShell: () => ({ kind: 'posix' })
}))
vi.mock('./terminal-paste-ssh-platform', () => ({ getTerminalPasteSshRemotePlatform: () => null }))
vi.mock('./terminal-drop-path-writer', () => ({
  writeTerminalDropPathsToCapturedTarget: mocks.write
}))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: mocks.activity }))
vi.mock('./terminal-native-file-drop-destination', () => ({
  handleNativeTerminalFileDrop: vi.fn()
}))

async function drop(
  source: string | null,
  targetHost: string | null,
  environmentId: string | null
) {
  const focus = vi.fn()
  const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler only enumerates the fixture pane and captures its identity; path writes are recorded separately.
  const manager = { getPanes: () => [pane] } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These are all transport methods used by the handler before the recorded path writer.
  const paneTransports = new Map([
    [
      1,
      {
        getPtyId: () => 'pty-1',
        getExecutionHostId: () => targetHost,
        getRuntimeEnvironmentId: () => environmentId
      }
    ]
  ]) as never
  const payload = new Map([[WORKSPACE_FILE_PATHS_MIME, '/same/path/file.txt']])
  if (source !== null) {
    payload.set(WORKSPACE_FILE_DRAG_SOURCE_MIME, source)
  }
  const result = await handleInternalTerminalFileDrop({
    manager,
    paneTransports,
    worktreeId: 'destination-workspace',
    tabId: 'tab-1',
    cwd: undefined,
    paneLeafId: 'leaf-1',
    dataTransfer: { getData: (type) => payload.get(type) ?? '' }
  })
  return { result, focus }
}

const source = (executionHostId: string, runtimeEnvironmentId?: string) =>
  JSON.stringify({
    version: 1,
    executionHostId,
    workspaceId: 'source-workspace',
    runtimeEnvironmentId
  })

describe('internal terminal drop source ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.write.mockResolvedValue({ sentAnyPath: true, targetCurrent: true, pathsWritten: 1 })
  })

  it.each([
    [source('runtime:env-a'), 'local', null],
    [source('local'), 'local', 'env-a'],
    [source('runtime:env-a'), 'local', 'env-b'],
    [source('ssh:target-a'), 'ssh:target-b', null],
    [source('runtime:unresolved-owner'), 'local', null],
    [null, 'local', null],
    ['{broken', 'local', null],
    [source('local'), null, null],
    [source('runtime:env-a'), 'runtime:env-a', 'env-b'],
    [source('ssh:target-a'), 'ssh:target-a', 'env-a'],
    [source('ssh:target-a', 'env-a'), 'ssh:target-a', null],
    [source('ssh:target-a', 'env-a'), 'ssh:target-a', 'env-b'],
    [source('runtime:env-a', 'env-b'), 'runtime:env-a', 'env-a']
  ])(
    'refuses an unverifiable or foreign source %s for %s / %s',
    async (payload, targetHost, environmentId) => {
      const { result, focus } = await drop(payload, targetHost, environmentId)
      expect(result).toEqual({ status: 'rejected', reason: 'source-host-mismatch' })
      expect(mocks.write).not.toHaveBeenCalled()
      expect(mocks.activity).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledWith('Drop files from the same host as this terminal.')
    }
  )

  it.each([
    ['local', 'local', null, undefined],
    ['runtime:env-a', 'local', 'env-a', undefined],
    ['runtime:env%20a', 'local', 'env a', undefined],
    ['runtime:env-a', 'runtime:env-a', 'env-a', undefined],
    ['ssh:target-a', 'ssh:target-a', null, undefined],
    ['ssh:target-a', 'ssh:target-a', 'env-a', 'env-a']
  ])(
    'keeps same-host sources across workspaces: %s into %s / %s',
    async (sourceHost, targetHost, environmentId, sourceEnvironmentId) => {
      const { result, focus } = await drop(
        source(sourceHost, sourceEnvironmentId),
        targetHost,
        environmentId
      )
      expect(result).toEqual({ status: 'pasted', pathCount: 1 })
      expect(mocks.write).toHaveBeenCalledWith(
        expect.objectContaining({ paths: ['/same/path/file.txt'] })
      )
      expect(focus).toHaveBeenCalledOnce()
    }
  )
})

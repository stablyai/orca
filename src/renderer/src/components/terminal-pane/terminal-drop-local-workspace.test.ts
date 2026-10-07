import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { handleInternalTerminalFileDrop, handleTerminalFileDrop } from './terminal-drop-handler'
import { encodeWorkspaceFilePaths, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    sshConnectionStates: new Map()
  },
  importPaths: vi.fn(),
  resolvePaths: vi.fn(),
  recordInput: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: mocks.recordInput }))

afterEach(() => vi.unstubAllGlobals())

describe('local terminals without catalog workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { fs: { resolveDroppedPathsForAgent: mocks.resolvePaths } } })
  })

  it.each(['native', 'internal'])(
    'preserves %s floating-terminal drops while a runtime is focused',
    async (lane) => {
      const sendInput = vi.fn(() => true)
      const focus = vi.fn()
      const pane = { id: 1, leafId: 'leaf-1', terminal: { focus } }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler only enumerates panes and captures their identity.
      const manager = { getPanes: () => [pane], getActivePane: () => pane } as never
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies every transport method used by local drops.
      const paneTransports = new Map([
        [
          1,
          {
            sendInput,
            getPtyId: () => 'pty-1',
            isConnected: () => true,
            getExecutionHostId: () => 'local'
          }
        ]
      ]) as never
      const args = {
        manager,
        paneTransports,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId: 'floating',
        cwd: '/terminal/cwd'
      }
      if (lane === 'native') {
        await handleTerminalFileDrop({
          ...args,
          data: { target: 'terminal', paneLeafId: 'leaf-1', paths: ['/local/file.txt'] }
        })
      } else {
        const result = await handleInternalTerminalFileDrop({
          ...args,
          paneLeafId: 'leaf-1',
          dataTransfer: {
            getData: (type) =>
              type === WORKSPACE_FILE_PATHS_MIME
                ? encodeWorkspaceFilePaths(['/local/file.txt'])
                : ''
          }
        })
        expect(result).toEqual({ status: 'pasted', pathCount: 1 })
      }
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('/local/file.txt ', 'driving')
      expect(focus).toHaveBeenCalled()
      expect(mocks.importPaths).not.toHaveBeenCalled()
      expect(mocks.resolvePaths).not.toHaveBeenCalled()
    }
  )
})

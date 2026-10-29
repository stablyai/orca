import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
import { useAppStore } from '@/store'
import type { TreeNode } from './file-explorer-types'
import { activateFileExplorerNode } from './useFileExplorerHandlers'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'

const originalState = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(originalState, true)
  toastError.mockClear()
})

afterEach(() => {
  useAppStore.setState(originalState, true)
  vi.unstubAllGlobals()
})

describe('activateFileExplorerNode', () => {
  const directoryNode: TreeNode = {
    name: 'src',
    path: '/repo/src',
    relativePath: 'src',
    isDirectory: true,
    depth: 0
  }
  const symlinkNode: TreeNode = {
    name: 'linked-docs',
    path: '/repo/linked-docs',
    relativePath: 'linked-docs',
    isDirectory: false,
    isSymlink: true,
    depth: 0,
    operationOwner: {
      kind: 'runtime',
      environmentId: 'runtime-env-1',
      executionHostId: 'runtime:runtime-env-1'
    }
  }

  it('selects filtered folders without mutating persisted expansion', async () => {
    const toggleDir = vi.fn()
    const setSelectedPath = vi.fn()

    await activateFileExplorerNode({
      node: directoryNode,
      activeWorktreeId: 'wt-1',
      openFile: vi.fn(),
      toggleDir,
      canToggleDirectories: false,
      loadDir: vi.fn(),
      statPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath
    })

    expect(setSelectedPath).toHaveBeenCalledWith('/repo/src')
    expect(toggleDir).not.toHaveBeenCalled()
  })

  it('expands a symlink only after explicit activation proves it is a directory', async () => {
    const loadDir = vi.fn().mockResolvedValue(true)
    const markPathAsDirectory = vi.fn()
    const toggleDir = vi.fn()
    const openFile = vi.fn()

    await activateFileExplorerNode({
      node: symlinkNode,
      activeWorktreeId: 'wt-1',
      openFile,
      toggleDir,
      loadDir,
      statPath: vi.fn().mockResolvedValue({ isDirectory: true }),
      markPathAsDirectory,
      setSelectedPath: vi.fn()
    })

    expect(loadDir).toHaveBeenCalledTimes(1)
    expect(loadDir).toHaveBeenCalledWith('/repo/linked-docs', 0, {
      force: true,
      failOnError: true,
      wakeWslDistro: true
    })
    expect(markPathAsDirectory).toHaveBeenCalledWith('/repo/linked-docs')
    expect(toggleDir).toHaveBeenCalledWith('wt-1', '/repo/linked-docs')
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not follow a folder link that leads out of the project', async () => {
    const loadDir = vi.fn()
    const openFile = vi.fn()

    await activateFileExplorerNode({
      node: { ...symlinkNode, operationOwner: { kind: 'local' } },
      activeWorktreeId: 'wt-1',
      openFile,
      toggleDir: vi.fn(),
      loadDir,
      statPath: vi.fn().mockResolvedValue({ isDirectory: true, escapesWorktree: true }),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    expect(loadDir).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      "This folder links outside the project, so it can't be opened here."
    )
  })

  it('opens a file link that leads out of the project by its absolute path', async () => {
    const openFile = vi.fn()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' } as never]
      }
    })

    await activateFileExplorerNode({
      node: { ...symlinkNode, operationOwner: { kind: 'local' } },
      activeWorktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn().mockResolvedValue({ isDirectory: false, escapesWorktree: true }),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    // The absolute relativePath marks the tab as user-named, which survives a restart.
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/linked-docs',
        relativePath: '/repo/linked-docs',
        worktreeId: 'wt-1'
      }),
      expect.anything()
    )
  })

  it('opens a symlink as a file when target stat fails', async () => {
    const openFile = vi.fn()
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo',
            hostId: 'runtime:runtime-env-1'
          } as never
        ]
      }
    })

    await activateFileExplorerNode({
      node: symlinkNode,
      activeWorktreeId: 'wt-1',
      runtimeEnvironmentId: 'runtime-env-1',
      openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn().mockRejectedValue(new Error('stat failed')),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })

    expect(openFile).toHaveBeenCalledWith(
      {
        filePath: '/repo/linked-docs',
        relativePath: 'linked-docs',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: 'runtime-env-1',
        language: expect.any(String),
        mode: 'edit'
      },
      { preview: true, focusEditor: true, suppressActiveRuntimeFallback: false }
    )
  })

  it.each(['README.md', 'report.html', 'REPORT.HTM'])(
    'opens %s in the editor without runtime fallback when no runtime owner is set',
    async (name) => {
      const fileNode: TreeNode = {
        name,
        path: `/repo/${name}`,
        relativePath: name,
        isDirectory: false,
        depth: 0,
        operationOwner: { kind: 'local' }
      }
      const openFile = vi.fn()
      useAppStore.setState({
        worktreesByRepo: {
          'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' } as never]
        }
      })

      await activateFileExplorerNode({
        node: fileNode,
        activeWorktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        openFile,
        toggleDir: vi.fn(),
        loadDir: vi.fn(),
        statPath: vi.fn(),
        markPathAsDirectory: vi.fn(),
        setSelectedPath: vi.fn()
      })

      expect(openFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: `/repo/${name}`,
          runtimeEnvironmentId: undefined
        }),
        { preview: true, focusEditor: true, suppressActiveRuntimeFallback: true }
      )
    }
  )
})

describe('file explorer open target', () => {
  const fileNode: TreeNode = {
    name: 'README.md',
    path: '/repo/README.md',
    relativePath: 'README.md',
    isDirectory: false,
    depth: 0,
    operationOwner: { kind: 'local' }
  }
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const events = new EventTarget()
    events.addEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, () => {
      useAppStore.setState(({ floatingWorkspacePanelOpen }) => ({
        floatingWorkspacePanelOpen: !floatingWorkspacePanelOpen
      }))
    })
    vi.stubGlobal('window', {
      api: {
        settings: {
          set: vi.fn(async (updates: Partial<GlobalSettings>) => ({
            ...useAppStore.getState().settings,
            ...updates
          }))
        }
      },
      dispatchEvent: (event: Event) => events.dispatchEvent(event)
    })
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/test'),
        fileExplorerOpenTarget: 'floating-workspace',
        floatingTerminalEnabled: true,
        activeRuntimeEnvironmentId: 'focused-server'
      },
      repos: [{ ...TEST_REPO, path: '/repo', executionHostId: 'local' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, path: '/repo', hostId: 'local' })
        ]
      },
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: 'local',
      activeTabId: 'chat-1',
      activeTabIdByWorktree: { 'wt-1': 'chat-1' },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      floatingWorkspacePanelOpen: false
    })
  })

  function activate(node = fileNode, activeWorktreeId = 'wt-1'): Promise<void> {
    return activateFileExplorerNode({
      node,
      activeWorktreeId,
      openFile: useAppStore.getState().openFile,
      toggleDir: vi.fn(),
      loadDir: vi.fn(),
      statPath: vi.fn(),
      markPathAsDirectory: vi.fn(),
      setSelectedPath: vi.fn()
    })
  }

  function runFrames(): void {
    frames.splice(0).forEach((frame) => frame(0))
  }

  it('opens permanent local tabs, reuses a repeated file, and preserves the main chat selection', async () => {
    await activate()
    runFrames()
    await activate()
    runFrames()

    const state = useAppStore.getState()
    expect(state.openFiles).toHaveLength(1)
    expect(state.openFiles[0]).toMatchObject({
      filePath: fileNode.path,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null
    })
    expect(state.openFiles[0].isPreview).toBeFalsy()
    expect(state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(state.floatingWorkspacePanelOpen).toBe(true)
    expect(state.activeWorktreeId).toBe('wt-1')
    expect(state.activeTabId).toBe('chat-1')
    expect(state.activeTabType).toBe('terminal')
    expect(state.pendingEditorFocusRequest?.worktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('waits for a disabled workspace to be enabled before creating a tab', async () => {
    const saved = Promise.withResolvers<void>()
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, floatingTerminalEnabled: false },
      updateSettingsOrThrow: async () => {
        await saved.promise
        useAppStore.setState(({ settings }) => ({
          settings: settings && { ...settings, floatingTerminalEnabled: true }
        }))
      }
    }))
    const opening = activate()
    expect(useAppStore.getState().openFiles).toHaveLength(0)
    saved.resolve()
    await opening
    runFrames()
    expect(useAppStore.getState().openFiles).toHaveLength(1)
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(true)
  })

  it('shares an in-flight enable write so concurrent clicks survive settings publication fences', async () => {
    const acknowledgement = Promise.withResolvers<GlobalSettings>()
    const setSettings = vi.fn(() => acknowledgement.promise)
    window.api.settings.set = setSettings
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, floatingTerminalEnabled: false }
    }))

    const first = activate()
    const second = activate({
      ...fileNode,
      name: 'other.md',
      path: '/repo/other.md',
      relativePath: 'other.md'
    })
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().openFiles).toHaveLength(0)
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Settings missing')
    }
    acknowledgement.resolve({ ...settings, floatingTerminalEnabled: true })
    await Promise.all([first, second])
    runFrames()

    expect(
      useAppStore
        .getState()
        .openFiles.map((file) => file.filePath)
        .sort()
    ).toEqual(['/repo/README.md', '/repo/other.md'])
    expect(
      useAppStore
        .getState()
        .openFiles.every((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    ).toBe(true)
    expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(true)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('rechecks the owner after enabling before creating a local floating tab', async () => {
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, floatingTerminalEnabled: false },
      updateSettingsOrThrow: async () => {
        useAppStore.setState(({ settings }) => ({
          settings: settings && { ...settings, floatingTerminalEnabled: true },
          repos: [
            {
              ...TEST_REPO,
              path: '/repo',
              executionHostId: 'ssh:box',
              connectionId: 'box'
            }
          ],
          worktreesByRepo: {
            [TEST_REPO.id]: [
              makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, path: '/repo', hostId: 'ssh:box' })
            ]
          },
          activeWorkspaceExecutionHostId: 'ssh:box'
        }))
      }
    }))
    await activate()
    expect(useAppStore.getState().openFiles).toHaveLength(0)
    expect(toastError).toHaveBeenCalledOnce()
  })

  it.each(['rejected', 'not-enabled'] as const)(
    'does not leave a hidden tab when enabling is %s',
    async (result) => {
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, floatingTerminalEnabled: false },
        updateSettingsOrThrow: async () => {
          if (result === 'rejected') {
            throw new Error('Settings save failed')
          }
        }
      }))
      await activate()
      runFrames()
      expect(useAppStore.getState().openFiles).toHaveLength(0)
      expect(useAppStore.getState().floatingWorkspacePanelOpen).toBe(false)
      expect(toastError).toHaveBeenCalledOnce()
    }
  )

  it('uses the same local owner routing for folder workspaces', async () => {
    useAppStore.setState({
      activeWorktreeId: 'folder:folder-1',
      folderWorkspaces: [makeFolderWorkspace({ folderPath: '/repo', executionHostId: 'local' })]
    })
    await activate(fileNode, 'folder:folder-1')
    expect(useAppStore.getState().openFiles[0]?.worktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it.each(['current-workspace', undefined] as const)(
    'preserves preview opens in the current workspace for preference %s',
    async (fileExplorerOpenTarget) => {
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, fileExplorerOpenTarget }
      }))
      await activate()
      expect(useAppStore.getState().openFiles[0]).toMatchObject({
        worktreeId: 'wt-1',
        isPreview: true
      })
      expect(frames).toHaveLength(0)
    }
  )

  it.each(['ssh', 'runtime'] as const)('keeps %s files on their owning workspace', async (kind) => {
    const hostId = kind === 'ssh' ? 'ssh:box' : 'runtime:server-1'
    useAppStore.setState({
      repos: [
        {
          ...TEST_REPO,
          path: '/repo',
          executionHostId: hostId,
          ...(kind === 'ssh' ? { connectionId: 'box' } : {})
        }
      ],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, path: '/repo', hostId })]
      },
      activeWorkspaceExecutionHostId: hostId
    })
    await activate({
      ...fileNode,
      operationOwner:
        kind === 'ssh'
          ? { kind: 'ssh', connectionId: 'box' }
          : { kind: 'runtime', environmentId: 'server-1', executionHostId: 'runtime:server-1' }
    })
    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      worktreeId: 'wt-1',
      isPreview: true
    })
    expect(frames).toHaveLength(0)
  })

  it('keeps browser clients in their current workspace', async () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    await activate()
    expect(useAppStore.getState().openFiles[0]?.worktreeId).toBe('wt-1')
    expect(frames).toHaveLength(0)
  })

  it('rejects an owner mismatch before enabling or creating a floating tab', async () => {
    await activate({ ...fileNode, operationOwner: { kind: 'ssh', connectionId: 'wrong-host' } })
    expect(useAppStore.getState().openFiles).toHaveLength(0)
    expect(toastError).toHaveBeenCalledOnce()
  })
})

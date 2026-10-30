// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { useAppStore } from '@/store'
import {
  RUNTIME_WORKTREE_PATH as RUNTIME_PATH,
  seedRemoteDropWorkspaces,
  sshConnectionStatesAt,
  SSH_WORKTREE_PATH as SSH_PATH
} from '@/lib/remote-workspace-drop-test-fixtures'
import { WORKSPACE_FILE_PATHS_MIME, writeWorkspaceFileDragSource } from '@/lib/workspace-file-drag'
import { joinPath } from '@/lib/path'
import { useEditorGroupFileDropOwner } from './use-editor-group-file-drop-owner'
import { captureEditorFileDropOpen } from './editor-dropped-file-open'
import * as crossPlatformPath from '../../../../shared/cross-platform-path'
import type * as ExplorerOwner from '../right-sidebar/file-explorer-operation-owner'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  rpc: vi.fn(),
  importPaths: vi.fn(),
  prepare: vi.fn(),
  openFile: vi.fn(),
  setActiveTabType: vi.fn(),
  toastError: vi.fn()
}))
const validateOwner = vi.hoisted(() => vi.fn())
vi.mock('../../../../shared/cross-platform-path', async (importOriginal) => {
  const actual = await importOriginal<typeof crossPlatformPath>()
  return {
    ...actual,
    normalizeRuntimePathForComparison: vi.fn(actual.normalizeRuntimePathForComparison)
  }
})
vi.mock('../right-sidebar/file-explorer-operation-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof ExplorerOwner>()
  return {
    ...actual,
    captureFileExplorerOperationGuard: (
      ...args: Parameters<typeof actual.captureFileExplorerOperationGuard>
    ) => {
      const guard = actual.captureFileExplorerOperationGuard(...args)
      return {
        ...guard,
        assertCurrent: () => {
          validateOwner()
          return guard.assertCurrent()
        }
      }
    }
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))

function EditorStrip({ worktreeId, groupId }: { worktreeId: string; groupId: string }) {
  const attach = useEditorGroupFileDropOwner({ worktreeId, groupId })
  return <div ref={attach} data-testid="strip" />
}

function dropFile(target: Element, name = 'shot.png'): void {
  const transfer = { types: ['Files'], files: [new File(['x'], name)], dropEffect: 'move' }
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
}

beforeEach(() => {
  seedRemoteDropWorkspaces()
  useAppStore.setState({ openFile: mocks.openFile, setActiveTabType: mocks.setActiveTabType })
  mocks.stat.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  mocks.rpc.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  mocks.importPaths.mockImplementation(async (_context, paths: string[], dir: string) => ({
    results: paths.map((path) => ({
      status: 'imported',
      kind: 'file',
      destPath: joinPath(dir, path.split('/').pop() ?? path)
    }))
  }))
  vi.stubGlobal('api', {
    fs: {
      stat: mocks.stat,
      getPathForFile: (file: File) => `/Users/me/Desktop/${file.name}`,
      prepareDroppedPaths: mocks.prepare
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('editor group OS file drops on remote workspaces', () => {
  it.each([
    { paths: 20, groups: 1, catalog: 1 },
    { paths: 200, groups: 1, catalog: 1 },
    { paths: 20, groups: 20, catalog: 1 },
    { paths: 20, groups: 200, catalog: 1 },
    { paths: 20, groups: 1, catalog: 20 },
    { paths: 20, groups: 1, catalog: 200 }
  ])('bounds stamped-drop work at P=$paths G=$groups W=$catalog', async (population) => {
    let groupVisits = 0
    let catalogVisits = 0
    const groups = Array.from({ length: population.groups }, (_, index) => ({
      get id() {
        groupVisits += 1
        return `group-${index}`
      },
      worktreeId: 'wt-runtime',
      activeTabId: null,
      tabOrder: []
    }))
    const baseWorktree = useAppStore.getState().worktreesByRepo['repo-rt'][0]
    const worktrees = Array.from({ length: population.catalog }, (_, index) => ({
      ...baseWorktree,
      get id() {
        catalogVisits += 1
        return index === population.catalog - 1 ? 'wt-runtime' : `other-${index}`
      },
      hostId: 'ssh:ssh-1' as const,
      runtimeOwnerEnvironmentId: 'owner-runtime'
    }))
    useAppStore.setState({
      activeWorktreeId: 'wt-runtime',
      activeWorkspaceExecutionHostId: 'ssh:ssh-1',
      worktreesByRepo: { 'repo-rt': worktrees },
      detectedWorktreesByRepo: {},
      groupsByWorktree: { 'wt-runtime': groups }
    })
    for (const [targetId, connection] of sshConnectionStatesAt(3)) {
      useAppStore.getState().setEnvironmentSshConnectionState('owner-runtime', targetId, connection)
    }
    const groupId = `group-${population.groups - 1}`
    const strips = groups.map((_, index) => (
      <EditorStrip key={index} worktreeId="wt-runtime" groupId={`group-${index}`} />
    ))
    const view = render(
      <>
        {strips}
        <EditorStrip worktreeId="wt-runtime" groupId={groupId} />
      </>
    )
    const detached = view.getAllByTestId('strip')[population.groups]
    view.rerender(<>{strips}</>)
    const paths = Array.from(
      { length: population.paths },
      (_, index) => `${RUNTIME_PATH}/${index}.ts`
    )
    const payload = new Map([[WORKSPACE_FILE_PATHS_MIME, JSON.stringify(paths)]])
    writeWorkspaceFileDragSource(
      { setData: (type, value) => payload.set(type, value) },
      {
        workspaceId: 'wt-runtime',
        executionHostId: 'ssh:ssh-1',
        runtimeEnvironmentId: 'owner-runtime'
      }
    )
    let inFlight = 0
    let peakInFlight = 0
    mocks.rpc.mockImplementation(async () => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return { isDirectory: false, size: 1, mtime: 0 }
    })
    groupVisits = 0
    catalogVisits = 0
    validateOwner.mockClear()
    const normalize = vi.mocked(crossPlatformPath.normalizeRuntimePathForComparison)
    normalize.mockClear()
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: [...payload.keys()],
        getData: (type: string) => payload.get(type) ?? ''
      }
    })
    act(() => {
      detached.dispatchEvent(event)
    })
    expect(normalize).not.toHaveBeenCalled()
    const comparisons = vi.spyOn(String.prototype, 'startsWith')
    act(() => {
      view.getAllByTestId('strip')[population.groups - 1].dispatchEvent(event)
    })
    const decoderComparisons = comparisons.mock.contexts.filter(
      (path) => typeof path === 'string' && paths.includes(path)
    ).length
    comparisons.mockRestore()
    const normalizations = normalize.mock.calls.length
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(population.paths))
    expect(normalizations).toBe(population.paths)
    // Path flavor detection needs two prefix checks per input; parent pruning must stay absent.
    expect(decoderComparisons).toBeLessThanOrEqual(2 * population.paths)
    expect(mocks.rpc).toHaveBeenCalledTimes(population.paths)
    expect(mocks.rpc.mock.calls.map(([, method, args]) => [method, args.relativePath])).toEqual(
      paths.map((_, index) => ['files.stat', `${index}.ts`])
    )
    expect(mocks.openFile.mock.calls.map(([file]) => file.filePath)).toEqual(paths)
    expect(peakInFlight).toBe(1)
    const validations = validateOwner.mock.calls.length
    expect(validations).toBeGreaterThanOrEqual(population.paths)
    expect(validations).toBeLessThanOrEqual(1 + 2 * population.paths)
    // Bound collection passes per validation, including capture before delivery.
    expect(groupVisits).toBeGreaterThanOrEqual(population.groups)
    expect(groupVisits).toBeLessThanOrEqual(2 * population.groups * validations)
    expect(catalogVisits).toBeGreaterThanOrEqual(population.catalog)
    expect(catalogVisits).toBeLessThanOrEqual(2 * population.catalog * (validations + 2))
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each(['wt-ssh', 'wt-runtime', 'nested-ssh'])(
    'opens existing explorer files in %s without uploading and skips folders',
    async (kind) => {
      const worktreeId = kind === 'nested-ssh' ? 'wt-runtime' : kind
      if (kind === 'nested-ssh') {
        useAppStore.setState((state) => ({
          worktreesByRepo: {
            ...state.worktreesByRepo,
            'repo-rt': state.worktreesByRepo['repo-rt'].map((wt) => ({
              ...wt,
              hostId: 'ssh:ssh-1',
              runtimeOwnerEnvironmentId: 'owner-runtime'
            }))
          }
        }))
        for (const [targetId, connection] of sshConnectionStatesAt(3)) {
          useAppStore
            .getState()
            .setEnvironmentSshConnectionState('owner-runtime', targetId, connection)
        }
      }
      const ssh = worktreeId === 'wt-ssh'
      const groupId = ssh ? 'group-ssh' : 'group-runtime'
      const root = ssh ? SSH_PATH : RUNTIME_PATH
      const paths = ['folder', 'folder/first.ts', 'second.md', 'last-folder'].map((path) =>
        joinPath(root, path)
      )
      const stat = (path: string) => ({
        isDirectory: [paths[0], paths[3]].includes(path),
        size: 1,
        mtime: 0
      })
      mocks.stat.mockImplementation(async ({ filePath }) => stat(filePath))
      mocks.rpc.mockImplementation(async (_target, _method, { relativePath }) =>
        stat(joinPath(root, relativePath))
      )
      const payload = new Map([[WORKSPACE_FILE_PATHS_MIME, JSON.stringify(paths)]])
      writeWorkspaceFileDragSource(
        { setData: (type, value) => payload.set(type, value) },
        {
          workspaceId: worktreeId,
          executionHostId: ssh || kind === 'nested-ssh' ? 'ssh:ssh-1' : 'runtime:owner-runtime',
          ...(kind === 'nested-ssh' ? { runtimeEnvironmentId: 'owner-runtime' } : {})
        }
      )
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: [...payload.keys()],
          getData: (type: string) => payload.get(type) ?? ''
        }
      })
      const view = render(<EditorStrip worktreeId={worktreeId} groupId={groupId} />)
      act(() => {
        view.getByTestId('strip').dispatchEvent(event)
      })
      await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(2))
      expect(mocks.openFile.mock.calls.map(([file]) => file.filePath)).toEqual(paths.slice(1, 3))
      expect(mocks.openFile).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId,
          runtimeEnvironmentId: ssh ? undefined : 'owner-runtime'
        }),
        { targetGroupId: groupId, suppressActiveRuntimeFallback: ssh, focusEditor: true }
      )
      expect(mocks.importPaths).not.toHaveBeenCalled()
      expect(mocks.prepare).not.toHaveBeenCalled()
    }
  )

  it('routes overlapping paired roots, reports failed files, and opens later selections', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('PRIVATE provider failure'))
    const open = captureEditorFileDropOpen(
      { worktreeId: 'wt-runtime', groupId: 'group-runtime' },
      { workspaceId: 'source-subfolder', executionHostId: 'runtime:owner-runtime' }
    )
    await open(['/srv/disjoint/no.ts', `${RUNTIME_PATH}/gone.ts`, `${RUNTIME_PATH}/sub/ok.md`])
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.rpc.mock.calls.map(([, method, args]) => [method, args])).toEqual([
      ['files.stat', { worktree: 'id:wt-runtime', relativePath: 'gone.ts' }],
      ['files.stat', { worktree: 'id:wt-runtime', relativePath: 'sub/ok.md' }]
    ])
    expect(mocks.openFile).toHaveBeenCalledTimes(1)
    expect(mocks.openFile.mock.calls[0][0].relativePath).toBe('sub/ok.md')
    expect(mocks.toastError.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/no.ts.*Open.*source workspace/),
      expect.stringMatching(/gone.ts.*Open.*source workspace/)
    ])
  })

  it('stops after the pending stat rejects if its group has closed', async () => {
    let rejectStat: (error: Error) => void = () => undefined
    mocks.rpc.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectStat = reject)))
    const open = captureEditorFileDropOpen(
      { worktreeId: 'wt-runtime', groupId: 'group-runtime' },
      { workspaceId: 'wt-runtime', executionHostId: 'runtime:owner-runtime' }
    )
    const pending = open([`${RUNTIME_PATH}/first.ts`, `${RUNTIME_PATH}/second.ts`])
    useAppStore.setState({ groupsByWorktree: {} })
    rejectStat(new Error('Disconnected'))
    await pending
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('uses the repo-derived SSH folder owner and refuses completion after reconnect', async () => {
    useAppStore.setState((state) => ({
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'project',
          name: 'Notes',
          folderPath: SSH_PATH,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ],
      repos: state.repos.map((repo) =>
        repo.id === 'repo-ssh'
          ? { ...repo, projectGroupId: 'project', path: `${SSH_PATH}/repo` }
          : repo
      ),
      groupsByWorktree: {
        'folder:notes': [
          { id: 'folder-group', worktreeId: 'folder:notes', activeTabId: null, tabOrder: [] }
        ]
      }
    }))
    const destination = { worktreeId: 'folder:notes', groupId: 'folder-group' }
    const source = { workspaceId: 'folder:notes', executionHostId: 'ssh:ssh-1' } as const
    await captureEditorFileDropOpen(destination, source)([`${SSH_PATH}/ok.md`])
    expect(mocks.stat).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ssh-1' }))
    expect(mocks.openFile).toHaveBeenCalledTimes(1)
    let finish: (stat: { isDirectory: boolean }) => void = () => undefined
    mocks.stat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const pending = captureEditorFileDropOpen(destination, source)([`${SSH_PATH}/later.md`])
    useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
    finish({ isDirectory: false })
    await pending
    expect(mocks.openFile).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringMatching(/Couldn't verify which host owns/)
    )
    captureEditorFileDropOpen(destination, { ...source, executionHostId: 'local' })
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      expect.stringMatching(/different host.*source workspace/)
    )
  })

  it("uploads an SSH group's drop into that workspace and opens it in that group", async () => {
    const view = render(<EditorStrip worktreeId="wt-ssh" groupId="group-ssh" />)
    dropFile(view.getByTestId('strip'))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    const [context, paths, dir] = mocks.importPaths.mock.calls[0]
    expect(context).toMatchObject({
      worktreeId: 'wt-ssh',
      worktreePath: SSH_PATH,
      connectionId: 'ssh-1',
      target: { kind: 'local' },
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 3
    })
    expect(paths).toEqual(['/Users/me/Desktop/shot.png'])
    expect(dir).toBe(joinPath(SSH_PATH, '.orca/drops'))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: joinPath(SSH_PATH, '.orca/drops/shot.png'),
        worktreeId: 'wt-ssh'
      }),
      { suppressActiveRuntimeFallback: true, targetGroupId: 'group-ssh' }
    )
  })

  it("uploads through the workspace's own runtime, not the focused one", async () => {
    const view = render(<EditorStrip worktreeId="wt-runtime" groupId="group-runtime" />)
    dropFile(view.getByTestId('strip'))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths.mock.calls[0][0]).toMatchObject({
      worktreeId: 'wt-runtime',
      target: { kind: 'environment', environmentId: 'owner-runtime' }
    })
    expect(mocks.importPaths.mock.calls[0][2]).toBe(joinPath(RUNTIME_PATH, '.orca/drops'))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-runtime', runtimeEnvironmentId: 'owner-runtime' }),
      { suppressActiveRuntimeFallback: false, targetGroupId: 'group-runtime' }
    )
  })

  it.each(['report.html', 'notes.txt'])(
    'refuses opening %s when its workspace changes hosts during upload',
    async (name) => {
      let finish: (result: {
        results: { status: 'imported'; kind: 'file'; destPath: string }[]
      }) => void = () => undefined
      mocks.importPaths.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      const view = render(<EditorStrip worktreeId="wt-runtime" groupId="group-runtime" />)
      dropFile(view.getByTestId('strip'), name)
      await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
      useAppStore.setState((state) => ({
        repos: state.repos.map((repo) =>
          repo.id === 'repo-rt' ? { ...repo, executionHostId: 'runtime:new-owner' as const } : repo
        )
      }))
      await act(async () =>
        finish({
          results: [
            {
              status: 'imported',
              kind: 'file',
              destPath: joinPath(RUNTIME_PATH, `.orca/drops/${name}`)
            }
          ]
        })
      )
      expect(mocks.openFile).not.toHaveBeenCalled()
      expect(mocks.setActiveTabType).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringMatching(/Couldn't verify which host owns/)
      )
    }
  )

  it.each(['wt-ssh', 'wt-runtime'])(
    'opens nothing when the group closes during upload in %s and keeps preparation feedback',
    async (worktreeId) => {
      let finish: (result: {
        results: { status: 'imported'; kind: 'file'; destPath: string }[]
      }) => void = () => undefined
      mocks.importPaths.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      mocks.prepare.mockResolvedValueOnce({
        paths: ['/Users/me/Desktop/shot.png'],
        failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
      })
      const groupId = worktreeId === 'wt-ssh' ? 'group-ssh' : 'group-runtime'
      const view = render(<EditorStrip worktreeId={worktreeId} groupId={groupId} />)
      dropFile(view.getByTestId('strip'))
      await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
      view.unmount()
      useAppStore.setState((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: [{ id: 'group-other', worktreeId, activeTabId: null, tabOrder: [] }]
        }
      }))
      await act(async () =>
        finish({ results: [{ status: 'imported', kind: 'file', destPath: '/uploaded/shot.png' }] })
      )
      expect(mocks.openFile).not.toHaveBeenCalled()
      expect(mocks.setActiveTabType).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses when the SSH connection changes before preparation finishes', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    const view = render(<EditorStrip worktreeId="wt-ssh" groupId="group-ssh" />)
    dropFile(view.getByTestId('strip'))
    // A reconnect is a new connection generation: the captured host no longer holds.
    useAppStore.setState({ sshConnectionStates: sshConnectionStatesAt(4) })
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't verify which host owns/)
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('refuses when the workspace runtime owner changes before preparation finishes', async () => {
    let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
    mocks.prepare.mockImplementationOnce(
      () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
    )
    const view = render(<EditorStrip worktreeId="wt-runtime" groupId="group-runtime" />)
    dropFile(view.getByTestId('strip'))
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) =>
        repo.id === 'repo-rt' ? { ...repo, executionHostId: 'runtime:new-owner' as const } : repo
      )
    }))
    await act(async () => finish({ paths: ['/Users/me/Desktop/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][0]).toMatch(/Couldn't verify which host owns/)
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })
})

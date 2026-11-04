// @vitest-environment happy-dom
import { Suspense, use } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createOsFileDropSequence } from '@/hooks/use-os-file-drop-owner'
import { WORKSPACE_FILE_PATHS_MIME, writeWorkspaceFileDragSource } from '@/lib/workspace-file-drag'
import type * as OsFileDropOwnerModule from '@/hooks/use-os-file-drop-owner'
import { useEditorGroupFileDropOwner } from './use-editor-group-file-drop-owner'

const mocks = vi.hoisted(() => {
  const groupsByWorktree: Record<string, { id: string }[]> = {}
  return {
    openFile: vi.fn(),
    setActiveTabType: vi.fn(),
    stat: vi.fn(),
    prepare: vi.fn(),
    toastError: vi.fn(),
    groupsByWorktree
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/hooks/use-os-file-drop-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof OsFileDropOwnerModule>()
  return { ...actual, createOsFileDropSequence: vi.fn(actual.createOsFileDropSequence) }
})

function EditorArea({ worktreeId, groupId }: { worktreeId: string; groupId: string }) {
  const attachArea = useEditorGroupFileDropOwner({ worktreeId, groupId })
  return <div ref={attachArea} data-testid={`${groupId}:area`} />
}

function EditorGroup({
  worktreeId,
  groupId,
  editorTabActive = true
}: {
  worktreeId: string
  groupId: string
  editorTabActive?: boolean
}) {
  const attachStrip = useEditorGroupFileDropOwner({ worktreeId, groupId })
  return (
    <>
      <div ref={attachStrip} data-testid={`${groupId}:strip`} />
      {/* Match TabGroupPanel: mount the editor area only for active editor tabs. */}
      {editorTabActive ? <EditorArea worktreeId={worktreeId} groupId={groupId} /> : null}
    </>
  )
}

function deferredPreparation(): (prepared: PreparedDroppedPaths) => void {
  let finish: (prepared: PreparedDroppedPaths) => void = () => undefined
  mocks.prepare.mockImplementationOnce(
    () => new Promise<PreparedDroppedPaths>((resolve) => (finish = resolve))
  )
  return (prepared) => finish(prepared)
}

function dropFile(target: Element, name: string): void {
  const transfer = { types: ['Files'], files: [new File(['x'], name)], dropEffect: 'move' }
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
}

const openedPaths = (): string[] => mocks.openFile.mock.calls.map(([file]) => file.filePath)

beforeEach(() => {
  mocks.groupsByWorktree = {
    'wt-b': [{ id: 'group-b' }],
    'folder:notes': [{ id: 'group-b' }],
    [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-group' }]
  }
  useAppStore.setState({
    settings: getDefaultSettings('/home/me'),
    repos: [{ ...TEST_REPO, executionHostId: 'local', connectionId: null }],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-b', repoId: TEST_REPO.id, path: '/repos/wt-b' })]
    },
    folderWorkspaces: [
      {
        id: 'notes',
        projectGroupId: 'project',
        name: 'Notes',
        folderPath: '/repos/wt-b',
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
    openFile: mocks.openFile,
    setActiveTabType: mocks.setActiveTabType
  })
  useAppStore.setState({
    groupsByWorktree: Object.fromEntries(
      Object.entries(mocks.groupsByWorktree).map(([worktreeId, groups]) => [
        worktreeId,
        groups.map(({ id }) => ({ id, worktreeId, activeTabId: null, tabOrder: [] }))
      ])
    )
  })
  mocks.stat.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  vi.stubGlobal('api', {
    fs: {
      stat: mocks.stat,
      getPathForFile: (file: File) => `/repos/wt-b/${file.name}`,
      prepareDroppedPaths: mocks.prepare
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('editor group OS file drops', () => {
  it.each(['strip', 'area', 'floating', 'folder'])(
    'opens explorer resources dropped on the %s through the existing file opener',
    async (root) => {
      const floating = root === 'floating'
      const worktreeId = floating
        ? FLOATING_TERMINAL_WORKTREE_ID
        : root === 'folder'
          ? 'folder:notes'
          : 'wt-b'
      const groupId = floating ? 'floating-group' : 'group-b'
      const view = render(<EditorGroup worktreeId={worktreeId} groupId={groupId} />)
      const filePath = `/repos/wt-b/notes.${root === 'area' ? 'html' : 'md'}`
      const payload = new Map([
        [WORKSPACE_FILE_PATHS_MIME, JSON.stringify(['/repos/wt-b', filePath])]
      ])
      writeWorkspaceFileDragSource(
        { setData: (type, value) => payload.set(type, value) },
        {
          workspaceId: 'wt-b',
          executionHostId: 'local'
        }
      )
      const transfer = {
        types: [...payload.keys()],
        getData: (type: string) => payload.get(type) ?? '',
        dropEffect: 'none'
      }
      mocks.stat.mockImplementation(async ({ filePath }) => ({
        isDirectory: filePath === '/repos/wt-b',
        size: 1,
        mtime: 0
      }))
      const target = view.getByTestId(`${groupId}:${floating || root === 'folder' ? 'area' : root}`)
      for (const type of ['dragover', 'drop']) {
        const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
        Object.defineProperty(event, 'dataTransfer', { value: transfer })
        act(() => {
          target.dispatchEvent(event)
        })
        expect(event.defaultPrevented).toBe(true)
      }
      expect(transfer.dropEffect).toBe('copy')
      await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
      expect(mocks.openFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath, worktreeId }),
        expect.objectContaining({ targetGroupId: groupId, focusEditor: true })
      )
      expect(mocks.prepare).not.toHaveBeenCalled()
    }
  )

  it.each(['strip', 'area'])(
    'opens a file dropped on the %s in that group and worktree, not the active one',
    async (root) => {
      const view = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
      dropFile(view.getByTestId(`group-b:${root}`), 'notes.md')
      await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
      expect(mocks.prepare).toHaveBeenCalledWith({
        paths: ['/repos/wt-b/notes.md'],
        consumer: 'main-reader'
      })
      expect(mocks.openFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repos/wt-b/notes.md',
          relativePath: 'notes.md',
          worktreeId: 'wt-b'
        }),
        { targetGroupId: 'group-b' }
      )
      expect(mocks.setActiveTabType).toHaveBeenCalledWith('editor', 'wt-b')
    }
  )

  it('opens a file dropped on the floating panel as a local floating tab', async () => {
    const view = render(
      <EditorGroup worktreeId={FLOATING_TERMINAL_WORKTREE_ID} groupId="floating-group" />
    )
    dropFile(view.getByTestId('floating-group:strip'), 'scratch.md')
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repos/wt-b/scratch.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null
      }),
      { preview: false, suppressActiveRuntimeFallback: true, targetGroupId: 'floating-group' }
    )
  })

  it('applies a strip drop then an area drop in drop order when the first prepares slower', async () => {
    const pending: (() => void)[] = []
    mocks.prepare.mockImplementation(
      ({ paths }: { paths: string[] }) =>
        new Promise<PreparedDroppedPaths>((resolve) =>
          pending.push(() => resolve({ paths, failures: [] }))
        )
    )
    const view = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
    dropFile(view.getByTestId('group-b:strip'), 'first.ts')
    dropFile(view.getByTestId('group-b:area'), 'second.ts')
    expect(pending).toHaveLength(2)
    await act(async () => pending[1]())
    expect(mocks.openFile).not.toHaveBeenCalled()
    await act(async () => pending[0]())
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(2))
    expect(openedPaths()).toEqual(['/repos/wt-b/first.ts', '/repos/wt-b/second.ts'])
  })

  it('still opens in the group when switching to a terminal tab unmounts the editor area', async () => {
    const finish = deferredPreparation()
    const view = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
    dropFile(view.getByTestId('group-b:area'), 'shot.png')
    view.rerender(<EditorGroup worktreeId="wt-b" groupId="group-b" editorTabActive={false} />)
    await act(async () => finish({ paths: ['/repos/wt-b/shot.png'], failures: [] }))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repos/wt-b/shot.png', worktreeId: 'wt-b' }),
      { targetGroupId: 'group-b' }
    )
  })

  it('opens nothing once the group closes during preparation, but still reports failures', async () => {
    const finish = deferredPreparation()
    const view = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
    dropFile(view.getByTestId('group-b:area'), 'shot.png')
    view.unmount()
    useAppStore.setState({ groupsByWorktree: {} })
    await act(async () =>
      finish({
        paths: ['/repos/wt-b/shot.png'],
        failures: [
          {
            target: 'rejected',
            reason: 'temp-copy-failed',
            commonReason: 'copy-failed',
            pathCount: 1,
            byteLength: 1
          }
        ]
      })
    )
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('keeps drop order when both roots remount while preparation is pending', async () => {
    const finish = deferredPreparation()
    const first = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
    dropFile(first.getByTestId('group-b:area'), 'first.ts')
    first.unmount()
    const second = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
    dropFile(second.getByTestId('group-b:strip'), 'second.ts')
    await act(async () => undefined)
    expect(mocks.openFile).not.toHaveBeenCalled()
    await act(async () => finish({ paths: ['/repos/wt-b/first.ts'], failures: [] }))
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(2))
    expect(openedPaths()).toEqual(['/repos/wt-b/first.ts', '/repos/wt-b/second.ts'])
  })

  it.each(['group', 'workspace'])(
    'opens nothing when the destination %s closes during stat and keeps preparation feedback',
    async (closed) => {
      let finish: (stat: { isDirectory: boolean; escapesWorktree: boolean }) => void = () =>
        undefined
      mocks.stat.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      mocks.prepare.mockResolvedValueOnce({
        paths: ['/repos/wt-b/shot.png'],
        failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
      })
      const view = render(<EditorGroup worktreeId="wt-b" groupId="group-b" />)
      dropFile(view.getByTestId('group-b:area'), 'shot.png')
      await waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(1))
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
      view.unmount()
      if (closed === 'workspace') {
        useAppStore.setState({ groupsByWorktree: {} })
      } else {
        useAppStore.setState({
          groupsByWorktree: {
            'wt-b': [{ id: 'group-other', worktreeId: 'wt-b', activeTabId: null, tabOrder: [] }]
          }
        })
      }
      await act(async () => finish({ isDirectory: false, escapesWorktree: false }))
      expect(mocks.openFile).not.toHaveBeenCalled()
      expect(mocks.setActiveTabType).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    }
  )

  it('creates no shared sequence for a render that never commits', async () => {
    const never = new Promise<never>(() => undefined)
    function SuspendedGroup() {
      useEditorGroupFileDropOwner({ worktreeId: 'wt-b', groupId: 'group-suspended' })
      use(never)
      return null
    }
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <SuspendedGroup />
        </Suspense>
      )
    })
    expect(createOsFileDropSequence).not.toHaveBeenCalled()
  })
})

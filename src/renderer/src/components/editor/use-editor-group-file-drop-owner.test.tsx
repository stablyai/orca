// @vitest-environment happy-dom
import { Suspense, use } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createOsFileDropSequence } from '@/hooks/use-os-file-drop-owner'
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
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/ssh-mutation-expectation', () => ({
  // Like the real lookup, a workspace with no host record fails closed.
  captureWorktreeSshMutationExpectation: (_state: unknown, worktreeId: string) => {
    if (!worktreeId.startsWith('wt-') && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      throw new Error('unresolved host')
    }
    return { expectedExecutionHostId: 'local' }
  }
}))
vi.mock('@/lib/file-owner-runtime-target', () => {
  const getRuntimeTargetForFileOwner = (
    _state: unknown,
    _worktreeId: string | null | undefined,
    _runtimeEnvironmentId: string | null | undefined
  ) => ({ kind: 'local' as const })
  return {
    FILE_OWNER_UNRESOLVED_MESSAGE: 'unresolved',
    getRuntimeTargetForFileOwner,
    requireRuntimeTargetForFileOwner: getRuntimeTargetForFileOwner,
    getRuntimeTargetForWorktreeOwner: (state: unknown, worktreeId: string | null | undefined) =>
      getRuntimeTargetForFileOwner(state, worktreeId, undefined)
  }
})
vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.stat }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      activeWorktreeId: 'wt-active',
      groupsByWorktree: mocks.groupsByWorktree,
      getKnownWorktreeById: (id: string) => ({ id, path: `/repos/${id}` }),
      setActiveTabType: mocks.setActiveTabType,
      openFile: mocks.openFile
    })
  }
}))

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
      {/* Like TabGroupPanel, the editor area only renders while an editor tab is active. */}
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
    [FLOATING_TERMINAL_WORKTREE_ID]: [{ id: 'floating-group' }]
  }
  mocks.stat.mockResolvedValue({ isDirectory: false, escapesWorktree: false })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  vi.stubGlobal('api', {
    fs: {
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
    mocks.groupsByWorktree['wt-b'] = [{ id: 'group-other' }]
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
        delete mocks.groupsByWorktree['wt-b']
      } else {
        mocks.groupsByWorktree['wt-b'] = [{ id: 'group-other' }]
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

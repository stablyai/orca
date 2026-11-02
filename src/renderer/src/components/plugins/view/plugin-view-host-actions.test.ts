// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerAppCommandDispatcher } from '@/lib/app-command-dispatch'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

function seedWorkspaces(openFile: ReturnType<typeof vi.fn>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only id and path of worktrees and id and folderPath of folders.
  useAppStore.setState({
    openFile,
    worktreesByRepo: { r1: [{ id: 'r1::/repo', path: '/repo' }] },
    folderWorkspaces: [{ id: 'f1', folderPath: 'C:\\notes' }]
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
}

describe('open-file', () => {
  it('opens a workspace file by its path inside the workspace, folders included', async () => {
    const openFile = vi.fn().mockReturnValue('file-1')
    seedWorkspaces(openFile)
    await expect(
      handlePluginViewRequest({
        requestId: 'r',
        kind: 'open-file',
        worktreeId: 'r1::/repo',
        relativePath: 'src/main.ts'
      })
    ).resolves.toEqual({ requestId: 'r', ok: true })
    expect(openFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/main.ts',
        relativePath: 'src/main.ts',
        worktreeId: 'r1::/repo',
        mode: 'edit'
      }),
      { preview: false }
    )
    await handlePluginViewRequest({
      requestId: 'f',
      kind: 'open-file',
      worktreeId: 'folder:f1',
      relativePath: 'todo/today.md'
    })
    expect(openFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ filePath: 'C:\\notes\\todo\\today.md', worktreeId: 'folder:f1' }),
      { preview: false }
    )
  })

  it('refuses a workspace this window does not list', async () => {
    seedWorkspaces(vi.fn())
    await expect(
      handlePluginViewRequest({
        requestId: 'x',
        kind: 'open-file',
        worktreeId: 'gone',
        relativePath: 'a.ts'
      })
    ).resolves.toMatchObject({ ok: false, code: 'workspace_not_found' })
  })
})

describe('run-action', () => {
  it("runs the window's own handler for the built-in action", async () => {
    const dispatcher = vi.fn().mockReturnValue(true)
    const unregister = registerAppCommandDispatcher(dispatcher)
    try {
      await expect(
        handlePluginViewRequest({
          requestId: 'a',
          kind: 'run-action',
          action: 'sidebar.left.toggle'
        })
      ).resolves.toEqual({ requestId: 'a', ok: true })
      expect(dispatcher).toHaveBeenCalledWith('sidebar.left.toggle', 'plugin-host')
      dispatcher.mockReturnValue(false)
      await expect(
        handlePluginViewRequest({ requestId: 'b', kind: 'run-action', action: 'view.tasks' })
      ).resolves.toMatchObject({ ok: false, code: 'action_unavailable' })
    } finally {
      unregister()
    }
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

const mocks = vi.hoisted(() => ({ statRuntimePath: vi.fn() }))

vi.mock('@/runtime/runtime-file-client', () => ({
  isRemoteRuntimeFileOperation: () => false,
  statRuntimePath: mocks.statRuntimePath
}))

import { statUserOpenedPath } from './user-opened-local-path'

const project: RuntimeFileOperationArgs = {
  target: { kind: 'local' as const },
  worktreeId: 'repo::/repo',
  worktreePath: '/repo'
}

/** Main's answers: a contained stat (no declared access) only sees paths that stay in the project. */
function answer(containedOk: boolean, userNamedOk: boolean, isDirectory = false): void {
  mocks.statRuntimePath.mockImplementation(
    async (_context: unknown, _path: string, access?: { kind: string }) => {
      if (access ? !userNamedOk : !containedOk) {
        throw new Error(
          access
            ? 'ENOENT: no such file'
            : 'Access denied: path resolves outside allowed directories.'
        )
      }
      return { size: 1, isDirectory, mtime: 1 }
    }
  )
}

describe('statUserOpenedPath', () => {
  beforeEach(() => {
    mocks.statRuntimePath.mockReset()
  })

  it('keeps a project file that stays in the project contained', async () => {
    answer(true, true)

    await expect(statUserOpenedPath(project, '/repo/src/a.ts')).resolves.toEqual({
      isDirectory: false,
      escapesWorktree: false
    })
    expect(mocks.statRuntimePath).toHaveBeenCalledTimes(1)
    expect(mocks.statRuntimePath).toHaveBeenCalledWith(project, '/repo/src/a.ts')
  })

  it.each([false, true])(
    'reports a project link that leads out of the project (directory: %s)',
    async (isDirectory) => {
      answer(false, true, isDirectory)

      await expect(statUserOpenedPath(project, '/repo/link')).resolves.toEqual({
        isDirectory,
        escapesWorktree: true
      })
      expect(mocks.statRuntimePath).toHaveBeenLastCalledWith(project, '/repo/link', {
        kind: 'user-file'
      })
    }
  )

  it.each(['ENOENT: no such file or directory', 'Remote connection dropped'])(
    'surfaces a project check that fails with %s instead of opening it as named',
    async (message) => {
      mocks.statRuntimePath.mockRejectedValue(new Error(message))

      await expect(statUserOpenedPath(project, '/repo/gone.md')).rejects.toThrow(message)
      expect(mocks.statRuntimePath).toHaveBeenCalledTimes(1)
    }
  )

  it('reports the project error when the path is missing everywhere', async () => {
    answer(false, false)

    await expect(statUserOpenedPath(project, '/repo/gone.md')).rejects.toThrow('Access denied')
  })

  it.each([
    ['outside the project', project, '/tmp/notes.md'],
    [
      'in the floating workspace, whose folder is not a project',
      { ...project, worktreeId: FLOATING_TERMINAL_WORKTREE_ID, worktreePath: '/Users/me' },
      '/Users/me/notes.md'
    ]
  ])('checks a path %s once, as user-named', async (_label, context, filePath) => {
    answer(false, true)

    await expect(statUserOpenedPath(context, filePath)).resolves.toEqual({
      isDirectory: false,
      escapesWorktree: false
    })
    expect(mocks.statRuntimePath).toHaveBeenCalledExactlyOnceWith(context, filePath, {
      kind: 'user-file'
    })
  })
})

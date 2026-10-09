import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { scheduleSelfWriteAwareEditorExternalReload } from './editor-external-watch-disk-verification'

vi.mock('@/runtime/runtime-file-client', () => ({ readRuntimeFileContent: vi.fn() }))

const target = {
  worktreeId: 'repo::/repo',
  worktreePath: '/repo',
  connectionId: 'ssh-1',
  runtimeEnvironmentId: 'hub-a'
}
const notification = { ...target, relativePath: 'file.txt' }

function file(runtimeEnvironmentId: string | null): OpenFile {
  return {
    id: '/repo/file.txt',
    filePath: '/repo/file.txt',
    relativePath: 'file.txt',
    worktreeId: target.worktreeId,
    language: 'plaintext',
    isDirty: false,
    mode: 'edit',
    runtimeEnvironmentId,
    externalSshTargetId: 'ssh-1'
  }
}

beforeEach(() => {
  vi.mocked(readRuntimeFileContent).mockReset()
  useAppStore.setState({ openFiles: [] })
})

describe('external editor verification ownership', () => {
  it('keeps verification reads separate when workspace selectors differ', async () => {
    const releases: (() => void)[] = []
    vi.mocked(readRuntimeFileContent).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ content: 'saved', isBinary: false }))
        })
    )
    try {
      for (const worktreeId of [target.worktreeId, 'other-repo::/repo']) {
        scheduleSelfWriteAwareEditorExternalReload(
          target,
          notification,
          { ...file('hub-a'), worktreeId },
          { content: 'saved' }
        )
      }
      expect(readRuntimeFileContent).toHaveBeenCalledTimes(2)
      expect(readRuntimeFileContent).toHaveBeenLastCalledWith(
        expect.objectContaining({ worktreeId: 'other-repo::/repo' })
      )
    } finally {
      releases.forEach((release) => release())
      await Promise.resolve()
    }
  })

  it.each([false, true])(
    'shares reads only for the same recorded owner (%s)',
    async (different) => {
      const releases: (() => void)[] = []
      vi.mocked(readRuntimeFileContent).mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ content: 'saved', isBinary: false }))
          })
      )
      try {
        for (const runtime of ['hub-a', different ? null : 'hub-a']) {
          scheduleSelfWriteAwareEditorExternalReload(target, notification, file(runtime), {
            content: 'saved'
          })
        }
        expect(readRuntimeFileContent).toHaveBeenCalledTimes(different ? 2 : 1)
        if (different) {
          expect(readRuntimeFileContent).toHaveBeenLastCalledWith(
            expect.objectContaining({
              settings: { activeRuntimeEnvironmentId: 'hub-a' },
              expectedExternalSshTargetId: 'ssh-1',
              expectedRuntimeEnvironmentId: null
            })
          )
        }
      } finally {
        releases.forEach((release) => release())
        await Promise.resolve()
      }
    }
  )
})

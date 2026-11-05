import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeFileWriteGuard, writeRuntimeFile } from './runtime-file-mutation-client'
import {
  fsWriteFile,
  installRuntimeFileClientEnvironment
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const context = {
  target: { kind: 'local' as const },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

afterEach(() => setRuntimeFileWriteGuard(null))

describe('runtime file write guard', () => {
  it('writes straight to disk when no guard is registered', async () => {
    await writeRuntimeFile(context, '/repo/a.ts', 'a')

    expect(fsWriteFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/a.ts', content: 'a' })
    )
  })

  it('runs the registered guard before the write', async () => {
    const order: string[] = []
    const guard = vi.fn(async (_context: unknown, filePath: string) => {
      order.push(`guard ${filePath}`)
    })
    setRuntimeFileWriteGuard(guard)
    fsWriteFile.mockImplementationOnce(async () => {
      order.push('write')
    })

    await writeRuntimeFile(context, '/repo/a.ts', 'a')

    expect(guard).toHaveBeenCalledWith(context, '/repo/a.ts')
    expect(order).toEqual(['guard /repo/a.ts', 'write'])
  })

  it('cancels the write when the guard throws', async () => {
    setRuntimeFileWriteGuard(async () => {
      throw new Error('declined')
    })

    await expect(writeRuntimeFile(context, '/repo/a.ts', 'a')).rejects.toThrow('declined')
    expect(fsWriteFile).not.toHaveBeenCalled()
  })
})

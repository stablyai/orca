import { describe, expect, it, vi } from 'vitest'

vi.mock('./preload-api/web-runtime-worktree-catalog', () => ({
  resolveRuntimeFilePath: vi.fn(async (path: string) => {
    if (path.includes('missing')) {
      throw new Error('not found')
    }
    return path
  })
}))

describe('web shell path existence', () => {
  it('defines pathsExist so withFallback cannot substitute an undefined-returning proxy', async () => {
    const { createShellApi } = await import('./preload-api/web-shell-api')
    const { withFallback } = await import('./preload-api/web-fallback-api')
    const shell = withFallback(createShellApi(), ['shell'])
    expect(shell.pathsExist).toBeTypeOf('function')
    const values = await shell.pathsExist?.(['/repo/present.ts', '/repo/missing.ts'])
    expect(values).toEqual([true, false])
  })
})

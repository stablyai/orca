import { afterEach, expect, it, vi } from 'vitest'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/links/files/terminal-path-existence-batch'
const remote = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/files/metadata/runtime-path-existence-batch', () => ({
  runtimePathsExist: remote
}))
const context = {
  target: { kind: 'local' as const },
  worktreeId: 'folder:/work',
  worktreePath: '/work'
}
afterEach(() => {
  vi.unstubAllGlobals()
  remote.mockReset()
})
it('chunks 257 paths without truncation and preserves each result position', async () => {
  const batch = vi.fn(async (paths: string[]) =>
    paths.map((path) => Number(path.slice(1)) % 2 === 0)
  )
  vi.stubGlobal('window', { api: { shell: { pathsExist: batch } } })
  const enqueue = createTerminalPathExistenceBatch()
  const results = await Promise.all(
    Array.from({ length: 257 }, (_, i) => enqueue(context, `/${i}`, false))
  )
  expect(batch.mock.calls.map((call) => call[0].length)).toEqual([128, 128, 1])
  expect(results).toEqual(Array.from({ length: 257 }, (_, i) => i % 2 === 0))
})
it('keeps a local batch answered when main refuses one path in it (E9)', async () => {
  const batch = vi.fn(async (paths: string[]) =>
    paths.map((path) =>
      path.startsWith('\\\\wsl.localhost\\')
        ? { error: "WSL distro 'Ubuntu' is not running." }
        : true
    )
  )
  vi.stubGlobal('window', { api: { shell: { pathsExist: batch } } })
  const enqueue = createTerminalPathExistenceBatch()
  const host = enqueue(context, '/host-file', false)
  const wsl = enqueue(context, '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts', false)
  await expect(host).resolves.toBe(true)
  // Unverifiable, never "missing": the caller retries it.
  await expect(wsl).rejects.toThrow('is not running')
  expect(batch).toHaveBeenCalledTimes(1)
})
it('rejects transport failure without turning it into a missing path', async () => {
  remote.mockRejectedValue(new Error('connection closed'))
  const enqueue = createTerminalPathExistenceBatch()
  await expect(
    Promise.all([
      enqueue({ ...context, connectionId: 'ssh' }, '/a', true),
      enqueue({ ...context, connectionId: 'ssh' }, '/b', true)
    ])
  ).rejects.toThrow('connection closed')
  expect(remote).toHaveBeenCalledTimes(1)
})

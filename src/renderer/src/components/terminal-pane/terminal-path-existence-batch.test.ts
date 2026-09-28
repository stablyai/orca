import { afterEach, expect, it, vi } from 'vitest'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/terminal-path-existence-batch'
import { requirePathExistenceResults } from '../../../../shared/path-existence-batch'
const remote = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-path-existence-batch', () => ({ runtimePathsExist: remote }))
const context = { settings: null, worktreeId: 'folder:/work', worktreePath: '/work' }
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
it('isolates identical paths by runtime, worktree, connection, and hover turn', async () => {
  remote.mockImplementation(async (_context, paths: string[]) =>
    paths.map(() => ({ exists: true }))
  )
  const enqueue = createTerminalPathExistenceBatch()
  const contexts = [
    { ...context, settings: { activeRuntimeEnvironmentId: 'a' } },
    { ...context, settings: { activeRuntimeEnvironmentId: 'b' } },
    {
      ...context,
      settings: { activeRuntimeEnvironmentId: 'a' },
      worktreeId: 'folder:/other',
      worktreePath: '/other'
    },
    { ...context, connectionId: 'ssh-one' },
    { ...context, connectionId: 'ssh-two' }
  ]
  await Promise.all(
    contexts.flatMap((ctx) => [enqueue(ctx, '/same', true), enqueue(ctx, '/same', true)])
  )
  expect(remote).toHaveBeenCalledTimes(5)
  expect(remote.mock.calls.map((call) => call[0])).toEqual(contexts)
  expect(remote.mock.calls.every((call) => call[1].length === 1)).toBe(true)
  await enqueue(contexts[0], '/same', true)
  expect(remote).toHaveBeenCalledTimes(6)
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
it.each([
  { rows: [{ exists: true, error: 'denied' }] },
  { rows: [{ exists: 'yes', error: 'denied' }] },
  { rows: [{ exists: false }, {}] }
])('rejects ambiguous or incomplete wire results $rows', ({ rows }) => {
  expect(() => requirePathExistenceResults(rows, rows.length)).toThrow(
    'Invalid path existence response'
  )
})

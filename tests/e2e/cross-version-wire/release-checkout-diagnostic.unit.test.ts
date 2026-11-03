import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FileSystemPromises from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { checkoutFetchTrace } from './release-checkout-diagnostic'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystemPromises>()
  return { ...original, mkdtemp: vi.fn(original.mkdtemp), rm: vi.fn(original.rm) }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test('reports fetch time without retaining arguments and removes its raw trace', async () => {
  vi.stubEnv('ORCA_RELEASE_CHECKOUT_DIAGNOSTIC', '1')
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const trace = await checkoutFetchTrace()
  if (!trace) {
    throw new Error('expected enabled trace')
  }
  const file = trace.env.GIT_TRACE2_EVENT
  await writeFile(
    file,
    [
      { event: 'child_start', sid: 'one', child_id: 0, argv: ['git', 'fetch', 'private-canary'] },
      { event: 'child_start', sid: 'two', child_id: 0, argv: ['git', 'config', 'private-canary'] },
      { event: 'child_exit', sid: 'two', child_id: 0, t_rel: 90 },
      { event: 'child_exit', sid: 'one', child_id: 0, t_rel: 1.25 }
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
  )
  await trace.finish('abc', 'git-archive')
  expect(output).toHaveBeenCalledExactlyOnceWith(
    '[release-checkout-fetch]',
    JSON.stringify({
      commit: 'abc',
      phase: 'git-archive',
      pid: process.pid,
      fetchStarts: 1,
      fetchExits: 1,
      fetchMs: 1250
    })
  )
  expect(JSON.stringify(output.mock.calls)).not.toContain('private-canary')
  await expect(access(dirname(file))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a child that never opens its trace still cleans up without replacing its result', async () => {
  vi.stubEnv('ORCA_RELEASE_CHECKOUT_DIAGNOSTIC', '1')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const trace = await checkoutFetchTrace()
  if (!trace) {
    throw new Error('expected enabled trace')
  }
  await expect(trace.finish('abc', 'git-archive')).resolves.toBeUndefined()
  await expect(access(dirname(trace.env.GIT_TRACE2_EVENT))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

test('unavailable diagnostic storage does not prevent the compatibility command', async () => {
  vi.stubEnv('ORCA_RELEASE_CHECKOUT_DIAGNOSTIC', '1')
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('private-canary'))
  await expect(checkoutFetchTrace()).resolves.toBeUndefined()
  expect(output).toHaveBeenCalledExactlyOnceWith(
    '[release-checkout-fetch]',
    JSON.stringify({ unavailable: true })
  )
})

test('failed diagnostic cleanup cannot replace the compatibility result', async () => {
  vi.stubEnv('ORCA_RELEASE_CHECKOUT_DIAGNOSTIC', '1')
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const trace = await checkoutFetchTrace()
  if (!trace) {
    throw new Error('expected enabled trace')
  }
  try {
    vi.mocked(rm).mockRejectedValueOnce(new Error('private-canary'))
    await expect(trace.finish('abc', 'git-archive')).resolves.toBeUndefined()
    expect(output).toHaveBeenLastCalledWith(
      '[release-checkout-fetch]',
      JSON.stringify({ cleanupFailed: true })
    )
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-canary')
  } finally {
    await rm(dirname(trace.env.GIT_TRACE2_EVENT), { recursive: true, force: true })
  }
})

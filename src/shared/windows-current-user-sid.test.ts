import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), sync: vi.fn() }))
vi.mock('./child-process/run-process', () => ({
  runProcess: mocks.run,
  runProcessSync: mocks.sync
}))
import {
  getCurrentWindowsUserSidAsync,
  resetSecureFileWindowsUserSidForTests
} from './windows-current-user-sid'
afterEach(() => {
  resetSecureFileWindowsUserSidForTests()
  vi.clearAllMocks()
})
it('uses asynchronous SID lookup on a cold protected write and caches only a verified SID', async () => {
  mocks.run.mockResolvedValue({
    code: 0,
    stdout: '"user","S-1-5-21-1-2-3-1000"',
    timedOut: false,
    outputTruncated: false
  })
  const signal = new AbortController().signal
  expect(await getCurrentWindowsUserSidAsync({ timeoutMs: 300, signal })).toBe(
    'S-1-5-21-1-2-3-1000'
  )
  expect(await getCurrentWindowsUserSidAsync({ timeoutMs: 300, signal })).toBe(
    'S-1-5-21-1-2-3-1000'
  )
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(mocks.run.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 300, signal })
  expect(mocks.sync).not.toHaveBeenCalled()
})
it('does not cache malformed or clipped SID output', async () => {
  mocks.run.mockResolvedValue({ code: 0, stdout: '"user","S-1-5-21-1"', outputTruncated: true })
  expect(await getCurrentWindowsUserSidAsync({ timeoutMs: 300 })).toBeNull()
  expect(await getCurrentWindowsUserSidAsync({ timeoutMs: 300 })).toBeNull()
  expect(mocks.run).toHaveBeenCalledTimes(2)
})

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from './child-process/run-process'
import {
  getCurrentWindowsUserSid,
  getCurrentWindowsUserSidAsync,
  resetSecureFileWindowsUserSidForTests
} from './windows-current-user-sid'

vi.mock('./child-process/run-process', () => ({ runProcess: vi.fn(), runProcessSync: vi.fn() }))

const success = {
  code: 0,
  signal: null,
  stdout: '"USER","S-1-5-21-1000"',
  stderr: '',
  timedOut: false
}

beforeEach(() => {
  resetSecureFileWindowsUserSidForTests()
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcessSync).mockReset()
})
afterEach(() => vi.restoreAllMocks())

it('retries transient lookup failures after the monotonic backoff', async () => {
  let clock = 10
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.mocked(runProcess).mockRejectedValueOnce(new Error('busy')).mockResolvedValue(success)
  expect(await getCurrentWindowsUserSidAsync()).toBeNull()
  expect(await getCurrentWindowsUserSidAsync()).toBeNull()
  expect(runProcess).toHaveBeenCalledTimes(1)
  clock += 60_000
  expect(await getCurrentWindowsUserSidAsync()).toBe('S-1-5-21-1000')
  expect(runProcess).toHaveBeenCalledTimes(2)
  expect(getCurrentWindowsUserSid()).toBe('S-1-5-21-1000')
  expect(runProcessSync).not.toHaveBeenCalled()
})

it('keeps a successful synchronous lookup when an older async lookup fails', async () => {
  const pending = Promise.withResolvers<typeof success>()
  vi.mocked(runProcess).mockReturnValue(pending.promise)
  vi.mocked(runProcessSync).mockReturnValue(success)
  const lookup = getCurrentWindowsUserSidAsync()
  expect(getCurrentWindowsUserSid()).toBe('S-1-5-21-1000')
  pending.reject(new Error('busy'))
  expect(await lookup).toBe('S-1-5-21-1000')
  expect(await getCurrentWindowsUserSidAsync()).toBe('S-1-5-21-1000')
  expect(runProcess).toHaveBeenCalledTimes(1)
})

it('rejects malformed successful lookup output', async () => {
  vi.mocked(runProcess).mockResolvedValue({ ...success, stdout: '"USER","not-a-sid"' })
  expect(await getCurrentWindowsUserSidAsync()).toBeNull()
  expect(await getCurrentWindowsUserSidAsync()).toBeNull()
  expect(runProcess).toHaveBeenCalledTimes(1)
})

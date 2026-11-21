import { expect, it, vi } from 'vitest'
import { monotonicNow } from '../../concurrency/deadline-settle-notifier'
import { readPsStdoutInProcess } from '../darwin/libproc-process-table'
import {
  getProcessTableSnapshot,
  getStrictProcessTableSnapshotWithAge,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import { PS_ARGS } from './process-table-snapshot'

vi.mock('../darwin/libproc-process-table', () => ({
  readPsStdoutBudgeted: vi.fn(),
  readPsStdoutInProcess: vi.fn()
}))
vi.mock('../darwin/darwin-process-table-capture', () => ({
  captureDarwinProcessTable: (capture: (args: readonly string[]) => Promise<string>) =>
    capture(PS_ARGS),
  resetDarwinProcessTableCaptureForTests: vi.fn()
}))

it('uses one new argv recovery for workspace evidence after a warm display capture', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  const nativeReader = vi.mocked(readPsStdoutInProcess)
  nativeReader.mockImplementation(async (_args, options) => {
    if (!options.freshArgv) {
      options.onArgvReadAt?.(monotonicNow() - 100)
    }
    const command = options.freshArgv ? '/bin/zsh' : '/bin/bash'
    return `101 1 101 101 S+ ttys001 Tue Nov 17 10:15:00 2026 ${command}\n`
  })
  try {
    expect(await getProcessTableSnapshot()).toMatchObject([{ command: '/bin/bash' }])
    vi.setSystemTime(1010)
    const reads = await Promise.all([
      getStrictProcessTableSnapshotWithAge(1010),
      getStrictProcessTableSnapshotWithAge(1010)
    ])
    expect(reads.map(({ rows }) => rows[0]?.command)).toEqual(['/bin/zsh', '/bin/zsh'])
    expect(nativeReader).toHaveBeenCalledTimes(2)
  } finally {
    resetProcessTableSnapshotForTests()
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
})

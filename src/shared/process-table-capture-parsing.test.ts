import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import * as processTableFormat from './process-table-snapshot'
import {
  getProcessTableSnapshot,
  getStrictProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  resetProcessTableSnapshotForTests()
})

describe('process table parsing on non-Linux hosts', () => {
  it.each(['darwin', 'win32'])('only parses the requested view on %s', async (hostPlatform) => {
    Object.defineProperty(process, 'platform', { value: hostPlatform })
    resetProcessTableSnapshotForTests()
    const lenient = vi.spyOn(processTableFormat, 'parseProcessTableRows')
    const strict = vi.spyOn(processTableFormat, 'parseStrictProcessTableRows')
    execFileMock.mockImplementation((_program, _args, _options, callback) => {
      callback(null, {
        stdout: '100 1 100 100 Ss+ ?? Fri Oct 9 12:34:56 2026 /bin/zsh\n',
        stderr: ''
      })
    })

    expect((await getStrictProcessTableSnapshot())[0]?.pid).toBe(100)
    expect(lenient).not.toHaveBeenCalled()
    expect(strict).toHaveBeenCalledTimes(1)
    await getStrictProcessTableSnapshot()
    expect(strict).toHaveBeenCalledTimes(1)
    expect((await getProcessTableSnapshot())[0]?.pid).toBe(100)
    expect(lenient).toHaveBeenCalledTimes(1)
  })
})

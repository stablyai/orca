import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

import { setLibprocAddonForTests, type LibprocAddon } from './libproc-addon'
import { resetNativeReadsForTests } from './libproc-native-reads'
import { runPsInProcess } from './libproc-process-table'
import { resetPsFallbackForTests } from './libproc-ps-fallback'

function installAddon(readProcessTable: LibprocAddon['readProcessTable']): void {
  setLibprocAddonForTests({
    readProcessTable,
    readProcessCwd: async () => null,
    readProcessPath: async () => null
  })
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  runProcess.mockImplementation(async ({ args }: { args: string[] }) => ({
    code: 0,
    signal: null,
    stdout: ` ${args.at(-1)} 1 1 Thu Sep  3 16:02:01 2026\n`,
    stderr: '',
    timedOut: false,
    outputTruncated: false
  }))
})

afterEach(() => {
  vi.useRealTimers()
  runProcess.mockReset()
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  resetPsFallbackForTests()
})

describe('ps fallback budget', () => {
  it('never answers a request with a fallback ps spawned before it, but shares one spawned after', async () => {
    installAddon(async () => {
      throw new Error('sysctl failed')
    })
    const finish: ((stdout: string) => void)[] = []
    runProcess.mockImplementation(
      () =>
        new Promise((resolve) =>
          finish.push((stdout) =>
            resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
          )
        )
    )
    // pid= only: a descendant read that would signal whatever pids it returns.
    const read = () => runPsInProcess(['-axo', 'pid='], { timeoutMs: 2000 })

    const early = read()
    await vi.advanceTimersByTimeAsync(0)
    expect(runProcess).toHaveBeenCalledTimes(1)
    const late = [read(), read()]
    await vi.advanceTimersByTimeAsync(0)
    expect(runProcess).toHaveBeenCalledTimes(2)
    finish[0]?.(' 9999\n')
    finish[1]?.(' 4242\n')
    expect((await early)?.stdout).toBe(' 9999\n')
    expect((await Promise.all(late)).map((result) => result?.stdout)).toEqual([
      ' 4242\n',
      ' 4242\n'
    ])
  })
})

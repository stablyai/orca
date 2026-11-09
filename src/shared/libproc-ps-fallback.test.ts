import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, execFile } = vi.hoisted(() => ({ runProcess: vi.fn(), execFile: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('node:child_process', () => ({ execFile }))

import { setLibprocAddonForTests, type LibprocAddon } from './libproc-addon'
import { resetNativeReadsForTests } from './libproc-native-reads'
import { runPsInProcess } from './libproc-process-table'
import { resetPsFallbackForTests } from './libproc-ps-fallback'
import { captureProcessTable } from './process-table-ps-capture'
import { PS_ARGS } from './process-table-snapshot'

const POLL_MS = 750
const STREAMS = 13
const ENV = { LC_ALL: 'C', LANG: 'C' }

function installAddon(readProcessTable: LibprocAddon['readProcessTable']): void {
  setLibprocAddonForTests({
    readProcessTable,
    readProcessCwd: async () => null,
    readProcessPath: async () => null
  })
}

/** The call-site shape every poller uses: the in-process reader, else its own ps. True when ps answered. */
async function poll(pid: number, background = false, timeoutMs = 2000): Promise<boolean> {
  const args = ['-o', 'pid=,ppid=,pgid=,lstart=', '-p', String(pid)]
  const options = { env: ENV, timeoutMs, maxOutputBytes: 4096, background }
  const result =
    (await runPsInProcess(args, options)) ?? (await runProcess({ program: 'ps', args, ...options }))
  return !result.timedOut
}

async function overOneMinute(
  streams = STREAMS,
  background = false
): Promise<{ forks: number; servedPerStream: number[] }> {
  const servedPerStream = Array<number>(streams).fill(0)
  const timers = Array.from({ length: streams }, (_, stream) =>
    setInterval(
      () =>
        void poll(7000 + stream, background).then((served) => {
          servedPerStream[stream] += Number(served)
        }),
      POLL_MS
    )
  )
  await vi.advanceTimersByTimeAsync(60_000)
  timers.forEach(clearInterval)
  await vi.advanceTimersByTimeAsync(2_000)
  return { forks: runProcess.mock.calls.length, servedPerStream }
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
  it('bounds ps forks across pollers while native reads keep rejecting', async () => {
    const readProcessTable = vi.fn(async () => {
      throw new Error('sysctl failed')
    })
    installAddon(readProcessTable)

    const { forks, servedPerStream } = await overOneMinute()
    expect(forks).toBeLessThanOrEqual(70)
    // Invocations take turns, so no poller is starved while another wins every token.
    expect(Math.min(...servedPerStream)).toBeGreaterThanOrEqual(4)
    // Backoff: rejection stops being retried on every poll.
    expect(readProcessTable.mock.calls.length).toBeLessThan(15)
  })

  it('bounds ps forks across pollers while the stalled-pool breaker is open', async () => {
    installAddon(vi.fn(() => new Promise<never>(() => {})))
    // Fill the cap with stalled reads and trip the breaker.
    for (let index = 0; index < 9; index += 1) {
      void runPsInProcess(['-p', String(5000 + index), '-o', 'pid='], { timeoutMs: 50 })
    }
    await vi.advanceTimersByTimeAsync(50)
    runProcess.mockClear()

    const { forks, servedPerStream } = await overOneMinute()
    expect(forks).toBeLessThanOrEqual(70)
    expect(Math.min(...servedPerStream)).toBeGreaterThanOrEqual(4)
  })

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

  it('sends forced subprocess captures (a held naming pass) through the same budget', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      execFile.mockImplementation((_file, _args, _options, callback) =>
        callback(null, { stdout: ' 1 0\n', stderr: '' })
      )
      let captured = 0
      // captureDarwinProcessTable's subprocessCapture while a naming pass is held, from five readers.
      const timers = Array.from({ length: 5 }, () =>
        setInterval(
          () =>
            void captureProcessTable(PS_ARGS, 2000, true).then(
              () => (captured += 1),
              () => {}
            ),
          POLL_MS
        )
      )
      await vi.advanceTimersByTimeAsync(60_000)
      timers.forEach(clearInterval)
      expect(execFile).not.toHaveBeenCalled()
      expect(runProcess.mock.calls.length).toBeLessThanOrEqual(65)
      expect(captured).toBeGreaterThan(runProcess.mock.calls.length)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('serves interactive reads ahead of a storm of display polls, still fair among the polls', async () => {
    installAddon(async () => {
      throw new Error('sysctl failed')
    })
    // A launch paste's terminal read (3s) every 5s, beside 20 steady-state display streams.
    let interactive = 0
    let interactiveServed = 0
    const paste = setInterval(() => {
      interactive += 1
      void poll(9000 + interactive, false, 3000).then((served) => {
        interactiveServed += Number(served)
      })
    }, 5_000)
    const { servedPerStream } = await overOneMinute(20, true)
    clearInterval(paste)

    expect(interactiveServed).toBe(interactive)
    expect(Math.min(...servedPerStream)).toBeGreaterThanOrEqual(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

import {
  DARWIN_TERMINAL_NAMING_STALL_MS,
  claimDarwinTerminalNaming,
  resetDarwinTerminalNamingForTests
} from './darwin-terminal-naming-single-flight'

import { setLibprocAddonForTests, type LibprocProcessRow } from './libproc-addon'
import { resetNativeReadsForTests } from './libproc-native-reads'
import { runPsInProcess } from './libproc-process-table'
import { resetPsFallbackForTests } from './libproc-ps-fallback'

const ROW: LibprocProcessRow = {
  pid: 4300,
  ppid: 1,
  pgid: 4300,
  tpgid: 4300,
  tdev: (16 << 24) | 4,
  status: 3,
  flags: 0x2,
  sessionLeader: false,
  startSec: 0,
  comm: 'zsh'
}

/** A naming pass stuck in an lstat that never returns; the spy counts reactions attached to it. */
function holdNamingSlot() {
  const held = new Promise<never>(() => {})
  const reactions = vi.spyOn(held, 'then')
  expect(claimDarwinTerminalNaming(() => held)).toBe(held)
  return reactions
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDarwinTerminalNamingForTests()
  resetNativeReadsForTests()
})
afterEach(() => {
  setLibprocAddonForTests(undefined)
  resetPsFallbackForTests()
  runProcess.mockReset()
  vi.useRealTimers()
})

describe('terminal naming single flight', () => {
  it('hands in-process tty= readers to ps once the pass outlives the stall threshold', async () => {
    holdNamingSlot()
    setLibprocAddonForTests({
      readProcessTable: async () => [ROW],
      readProcessCwd: async () => null,
      readProcessPath: async () => null
    })
    const args = ['-p', '4300', '-o', 'pid=,tty=']

    const ps = { code: 0, signal: null, stdout: ' 4300 ttys004\n', stderr: '', timedOut: false }
    runProcess.mockResolvedValue(ps)

    const waiting = runPsInProcess(args, { timeoutMs: 5_000 })
    await vi.advanceTimersByTimeAsync(DARWIN_TERMINAL_NAMING_STALL_MS)
    expect(await waiting).toEqual(ps)
    expect(await runPsInProcess(args, { timeoutMs: 5_000 })).toEqual(ps)
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ program: '/bin/ps', args }))
  })
})

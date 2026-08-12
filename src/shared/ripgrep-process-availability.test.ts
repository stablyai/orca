import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  isRipgrepSpawnCwdUsable,
  killSpawnedRipgrepProcess
} from './ripgrep-process-availability'

function createChild(pid: number | undefined): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.defineProperty(child, 'pid', { value: pid })
  return child
}

describe('ripgrep process availability', () => {
  it('recognizes native pre-spawn failures before either event wins the race', () => {
    expect(isRipgrepUnavailableExit(createChild(undefined), null, null)).toBe(true)
    expect(isRipgrepUnavailableExit(createChild(undefined), -2, null)).toBe(true)
  })

  it('keeps all post-spawn and signal exits on their existing paths', () => {
    for (const code of [0, 1, 2, 127]) {
      expect(isRipgrepUnavailableExit(createChild(1), code, null)).toBe(false)
    }
    expect(isRipgrepUnavailableExit(createChild(1), null, 'SIGTERM')).toBe(false)
  })

  it('tags only unsupported native launcher exits after spawn', () => {
    for (const code of [0, 1, 2]) {
      expect(
        isRipgrepUnavailableExit(createChild(1), code, null, {
          classifyNativeLauncherExit: true
        })
      ).toBe(false)
    }
    for (const code of [3, 126, 127, 9009]) {
      expect(
        isRipgrepUnavailableExit(createChild(1), code, null, {
          classifyNativeLauncherExit: true
        })
      ).toBe(true)
    }
  })

  it('does not signal a real failed-spawn handle', async () => {
    const child = spawn('orca-definitely-missing-rg-admission-test', [])
    const error = new Promise<void>((resolve) => child.once('error', () => resolve()))
    const close = new Promise<void>((resolve) => child.once('close', () => resolve()))

    expect(killSpawnedRipgrepProcess(child)).toBe(false)
    await Promise.all([error, close])
  })

  it('distinguishes a usable root from a missing spawn cwd', async () => {
    await expect(isRipgrepSpawnCwdUsable(process.cwd())).resolves.toBe(true)
    await expect(
      isRipgrepSpawnCwdUsable(join(process.cwd(), 'orca-definitely-missing-rg-cwd'))
    ).resolves.toBe(false)
  })

  it('absorbs a queued spawn error when cleanup wins the race', () => {
    const child = createChild(undefined)
    absorbPendingRipgrepSpawnError(child, {
      errorObserved: false,
      unavailableExitObserved: false
    })

    expect(() => child.emit('error', new Error('spawn rg ENOENT'))).not.toThrow()
    expect(child.listenerCount('error')).toBe(0)
  })

  it('does not retain a sink for started or already-observed processes', () => {
    const started = createChild(1)
    absorbPendingRipgrepSpawnError(started, {
      errorObserved: false,
      unavailableExitObserved: false
    })
    const observed = createChild(undefined)
    absorbPendingRipgrepSpawnError(observed, {
      errorObserved: true,
      unavailableExitObserved: true
    })

    expect(started.listenerCount('error')).toBe(0)
    expect(observed.listenerCount('error')).toBe(0)
  })
})

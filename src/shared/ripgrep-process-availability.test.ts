import { spawn, ChildProcess } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'
import {
  absorbPendingRipgrepSpawnError,
  killSpawnedRipgrepProcess
} from './ripgrep-process-availability'

function createChild(pid: number | undefined): ChildProcess {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: pid })
  return child
}

describe('ripgrep process availability', () => {
  it('does not signal a real failed-spawn handle', async () => {
    const child = spawn('orca-definitely-missing-rg-admission-test', [])
    const error = new Promise<void>((resolve) => child.once('error', () => resolve()))
    const close = new Promise<void>((resolve) => child.once('close', () => resolve()))

    const kill = vi.spyOn(child, 'kill')
    try {
      expect(killSpawnedRipgrepProcess(child)).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      await Promise.all([error, close])
      kill.mockRestore()
    }
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
})

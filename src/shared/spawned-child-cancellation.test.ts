import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { terminateSpawnedChild } from './spawned-child-cancellation'

describe('terminateSpawnedChild', () => {
  it('survives cancellation before an absent command reports its spawn error', async () => {
    const child = spawn(`orca-absent-command-${process.pid}-${Date.now()}`)
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
    })

    expect(child.pid).toBeUndefined()
    terminateSpawnedChild(child)

    await closed
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })
})

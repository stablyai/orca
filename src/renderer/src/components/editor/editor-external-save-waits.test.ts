import { describe, expect, it, vi } from 'vitest'
import { createExternalEditorSaveWaits } from './editor-external-save-waits'

/** Control settlement without relying on timer races. */
function pendingWrite() {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('external editor save ownership', () => {
  it('waits for old and new ID writes, including writes added during a drain', async () => {
    const waits = createExternalEditorSaveWaits()
    const oldWrite = pendingWrite()
    const newWrite = pendingWrite()
    waits.track(['caller'], oldWrite.promise)
    const finished = vi.fn()
    const drain = waits.wait('caller').then(finished)
    waits.track(['caller'], newWrite.promise)
    oldWrite.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    newWrite.resolve()
    await drain
    expect(finished).toHaveBeenCalledOnce()
  })

  it('drops a cancelled observer without dropping another observer or its write', async () => {
    const waits = createExternalEditorSaveWaits()
    const write = pendingWrite()
    waits.track(['cancelled', 'active'], write.promise)
    waits.track(['active'], write.promise)
    waits.release('cancelled')
    await waits.wait('cancelled')
    const finished = vi.fn()
    const drain = waits.wait('active').then(finished)
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    write.resolve()
    await drain
    expect(finished).toHaveBeenCalledOnce()
  })

  it('drains all writes, including new writes, before rejecting with the first failure', async () => {
    const waits = createExternalEditorSaveWaits()
    const failed = pendingWrite()
    const pending = pendingWrite()
    const added = pendingWrite()
    waits.track(['caller'], failed.promise)
    waits.track(['caller'], pending.promise)
    const finished = vi.fn()
    const drain = waits.wait('caller').then(finished, finished)
    const firstError = new Error('disk unavailable')
    failed.reject(firstError)
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    waits.track(['caller'], added.promise)
    pending.reject(new Error('later failure'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    added.resolve()
    await drain
    expect(finished).toHaveBeenCalledExactlyOnceWith(firstError)
    await expect(waits.wait('caller')).rejects.toBe(firstError)
  })

  it('retains an already settled failure without an unhandled rejection until release', async () => {
    const waits = createExternalEditorSaveWaits()
    const write = pendingWrite()
    waits.track(['caller', 'other'], write.promise)
    const failure = new Error('disk unavailable')
    write.reject(failure)
    await new Promise((resolve) => setImmediate(resolve))
    await expect(waits.wait('caller')).rejects.toBe(failure)
    waits.release('caller')
    waits.track(['caller'], Promise.resolve())
    await expect(waits.wait('caller')).resolves.toBeUndefined()
    await expect(waits.wait('other')).rejects.toBe(failure)
    waits.clear()
    await expect(waits.wait('other')).resolves.toBeUndefined()
  })
})

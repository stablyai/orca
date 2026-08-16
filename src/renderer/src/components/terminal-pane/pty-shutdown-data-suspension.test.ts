import { expect, it, vi } from 'vitest'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  drainRolledBackPtyShutdownData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyDataSidecars,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers,
  ptyTeardownHandlers,
  unregisterPtyDataHandlers
} from './pty-shutdown-data-suspension'
import { bufferPreHandlerPtyData } from './pty-pre-handler-buffer'
import { PtyShutdownOutputQueue } from './pty-shutdown-output-queue'

it('does not remove handlers installed by a remount while sleep is pending', () => {
  const ptyId = 'pty-shutdown-remount'
  const originalData = vi.fn()
  const originalReplay = vi.fn()
  const replacementData = vi.fn()
  const replacementReplay = vi.fn()
  ptyDataHandlers.set(ptyId, originalData)
  ptyReplayHandlers.set(ptyId, originalReplay)

  const [snapshot] = unregisterPtyDataHandlers([ptyId])
  ptyDataHandlers.set(ptyId, replacementData)
  ptyReplayHandlers.set(ptyId, replacementReplay)
  snapshot.commit()

  expect(ptyDataHandlers.get(ptyId)).toBe(replacementData)
  expect(ptyReplayHandlers.get(ptyId)).toBe(replacementReplay)
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
})

it('replays rollback output in its original replay and live arrival order', () => {
  const ptyId = 'pty-shutdown-output-order'
  const delivered: string[] = []
  const meta = { seq: 9, rawLength: 3, transformed: true }
  const sidecar = vi.fn((data: string) => delivered.push(`sidecar:${data}`))
  ptyDataHandlers.set(ptyId, (data) => delivered.push(`data:${data}`))
  ptyReplayHandlers.set(ptyId, (data) => delivered.push(`replay:${data}`))
  ptyDataSidecars.set(ptyId, new Set([sidecar]))

  const [snapshot] = unregisterPtyDataHandlers([ptyId])
  bufferPtyShutdownReplayData(ptyId, 'old')
  bufferPtyShutdownData(ptyId, 'new', meta)
  snapshot.rollback()

  expect(delivered).toEqual(['replay:old', 'data:new', 'sidecar:new'])
  expect(sidecar).toHaveBeenCalledOnce()
  ptyDataHandlers.delete(ptyId)
  ptyDataSidecars.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
})

it('drains pre-handler data before ordered shutdown output', () => {
  const ptyId = 'pty-shutdown-pre-handler-order'
  const delivered: string[] = []
  const preHandlerMeta = { seq: 1, rawLength: 3 }
  const shutdownMeta = { seq: 2, rawLength: 4, background: true }
  const dataHandler = vi.fn((data: string) => delivered.push(`data:${data}`))
  ptyDataHandlers.set(ptyId, dataHandler)
  ptyReplayHandlers.set(ptyId, (data) => delivered.push(`replay:${data}`))
  ptyDataSidecars.set(ptyId, new Set([(data) => delivered.push(`sidecar:${data}`)]))

  const [snapshot] = unregisterPtyDataHandlers([ptyId])
  bufferPreHandlerPtyData(ptyId, 'pre', preHandlerMeta)
  bufferPtyShutdownReplayData(ptyId, 'old')
  bufferPtyShutdownData(ptyId, 'live', shutdownMeta)
  snapshot.rollback()

  expect(delivered).toEqual(['data:pre', 'sidecar:pre', 'replay:old', 'data:live', 'sidecar:live'])
  expect(dataHandler).toHaveBeenNthCalledWith(1, 'pre', preHandlerMeta)
  expect(dataHandler).toHaveBeenNthCalledWith(2, 'live', shutdownMeta)
  ptyDataHandlers.delete(ptyId)
  ptyDataSidecars.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
})

it('retains ordered rollback output across detach and another pending shutdown', () => {
  const ptyId = 'pty-shutdown-detached-overlap'
  const originalData = vi.fn()
  const originalReplay = vi.fn()
  const drain = vi.spyOn(PtyShutdownOutputQueue.prototype, 'drain')
  const encode = vi.spyOn(TextEncoder.prototype, 'encode')
  ptyDataHandlers.set(ptyId, originalData)
  ptyReplayHandlers.set(ptyId, originalReplay)

  const [first] = unregisterPtyDataHandlers([ptyId])
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
  const meta = { seq: 3, rawLength: 10, transformed: true }
  bufferPtyShutdownData(ptyId, 'live-first', meta)
  bufferPtyShutdownReplayData(ptyId, 'replay-second')
  first.rollback()
  expect(drain).not.toHaveBeenCalled()

  const [second] = unregisterPtyDataHandlers([ptyId])
  expect(encode).not.toHaveBeenCalled()
  const delivered: string[] = []
  const replacementData = vi.fn((data: string) => delivered.push(`data:${data}`))
  ptyDataHandlers.set(ptyId, replacementData)
  ptyReplayHandlers.set(ptyId, (data) => delivered.push(`replay:${data}`))
  drainRolledBackPtyShutdownData(ptyId)
  expect(delivered).toEqual([])
  expect(drain).not.toHaveBeenCalled()

  second.rollback()
  expect(delivered).toEqual(['data:live-first', 'replay:replay-second'])
  expect(replacementData).toHaveBeenCalledWith('live-first', meta)
  expect(drain).toHaveBeenCalledOnce()
  drain.mockRestore()
  encode.mockRestore()
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
  ptyTeardownHandlers.delete(ptyId)
  ptyShutdownLifecycleHandlers.delete(ptyId)
})

it('detaches the delivered batch from a reentrant shutdown queue', () => {
  const ptyId = 'pty-shutdown-reentrant-delivery'
  const delivered: string[] = []
  let reentrantSnapshot: ReturnType<typeof unregisterPtyDataHandlers>[number] | undefined
  ptyDataHandlers.set(ptyId, (data) => {
    delivered.push(data)
    if (data === 'old-first') {
      reentrantSnapshot = unregisterPtyDataHandlers([ptyId])[0]
      bufferPtyShutdownData(ptyId, 'new-pending')
    }
  })
  ptyReplayHandlers.set(ptyId, vi.fn())

  const [first] = unregisterPtyDataHandlers([ptyId])
  bufferPtyShutdownData(ptyId, 'old-first')
  bufferPtyShutdownData(ptyId, 'old-second')
  first.rollback()

  expect(delivered).toEqual(['old-first', 'old-second'])
  expect(isPtyDataHandlerShutdownPending(ptyId)).toBe(true)
  reentrantSnapshot?.rollback()
  expect(delivered).toEqual(['old-first', 'old-second', 'new-pending'])
  expect(isPtyDataHandlerShutdownPending(ptyId)).toBe(false)
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
})

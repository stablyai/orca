import { expect, it, vi } from 'vitest'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  drainRolledBackPtyShutdownData,
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers,
  ptyTeardownHandlers,
  unregisterPtyDataHandlers
} from './pty-shutdown-data-suspension'

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
  ptyDataHandlers.set(ptyId, (data) => delivered.push(`data:${data}`))
  ptyReplayHandlers.set(ptyId, (data) => delivered.push(`replay:${data}`))

  const [snapshot] = unregisterPtyDataHandlers([ptyId])
  bufferPtyShutdownReplayData(ptyId, 'old')
  bufferPtyShutdownData(ptyId, 'new')
  snapshot.rollback()

  expect(delivered).toEqual(['replay:old', 'data:new'])
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
})

it('retains ordered rollback output across detach and another pending shutdown', () => {
  const ptyId = 'pty-shutdown-detached-overlap'
  const originalData = vi.fn()
  const originalReplay = vi.fn()
  ptyDataHandlers.set(ptyId, originalData)
  ptyReplayHandlers.set(ptyId, originalReplay)

  const [first] = unregisterPtyDataHandlers([ptyId])
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
  bufferPtyShutdownData(ptyId, 'live-first')
  bufferPtyShutdownReplayData(ptyId, 'replay-second')
  first.rollback()

  const [second] = unregisterPtyDataHandlers([ptyId])
  const delivered: string[] = []
  ptyDataHandlers.set(ptyId, (data) => delivered.push(`data:${data}`))
  ptyReplayHandlers.set(ptyId, (data) => delivered.push(`replay:${data}`))
  drainRolledBackPtyShutdownData(ptyId)
  expect(delivered).toEqual([])

  second.rollback()
  expect(delivered).toEqual(['data:live-first', 'replay:replay-second'])
  ptyDataHandlers.delete(ptyId)
  ptyReplayHandlers.delete(ptyId)
  ptyTeardownHandlers.delete(ptyId)
  ptyShutdownLifecycleHandlers.delete(ptyId)
})

import { afterEach, expect, it, vi } from 'vitest'
import { leaveSettingsThen, registerSettingsLeaveGuard } from './settings-leave-guard'

let unregister: (() => void) | null = null
afterEach(() => {
  unregister?.()
  unregister = null
})

function deferredGuard(): {
  guard: (signal: AbortSignal) => Promise<boolean>
  approve: () => void
  signal: () => AbortSignal | null
} {
  let resolve: (value: boolean) => void = () => {}
  let lastSignal: AbortSignal | null = null
  return {
    guard: (signal) => {
      lastSignal = signal
      return new Promise<boolean>((done) => {
        resolve = done
        signal.addEventListener('abort', () => done(false), { once: true })
      })
    },
    approve: () => resolve(true),
    signal: () => lastSignal
  }
}

it('leaves at once when nothing guards Settings', async () => {
  const leave = vi.fn()
  await leaveSettingsThen(() => true, leave)
  expect(leave).toHaveBeenCalledTimes(1)
})

it('aborts the open confirmation when Settings unmounts and lets the next visit ask again', async () => {
  const deferred = deferredGuard()
  const stop = registerSettingsLeaveGuard(deferred.guard)
  const stale = vi.fn()
  const pending = leaveSettingsThen(() => true, stale)
  stop()
  await pending
  expect(deferred.signal()?.aborted).toBe(true)
  expect(stale).not.toHaveBeenCalled()

  unregister = registerSettingsLeaveGuard(async () => true)
  const next = vi.fn()
  await leaveSettingsThen(() => true, next)
  expect(next).toHaveBeenCalledTimes(1)
})

it('drops an approval that arrives after a newer Settings visit registered', async () => {
  let approveOld: (value: boolean) => void = () => {}
  registerSettingsLeaveGuard(() => new Promise<boolean>((done) => (approveOld = done)))
  const stale = vi.fn()
  const pending = leaveSettingsThen(() => true, stale)
  unregister = registerSettingsLeaveGuard(async () => true)
  approveOld(true)
  await pending
  expect(stale).not.toHaveBeenCalled()
})

it("lets an old request's cleanup leave a newer pending request alone", async () => {
  let releaseOld: (value: boolean) => void = () => {}
  const stopOld = registerSettingsLeaveGuard(
    () => new Promise<boolean>((done) => (releaseOld = done))
  )
  const oldRequest = leaveSettingsThen(() => true, vi.fn())
  stopOld()

  let approveNew: (value: boolean) => void = () => {}
  unregister = registerSettingsLeaveGuard(() => new Promise<boolean>((done) => (approveNew = done)))
  const newIntent = vi.fn()
  const newRequest = leaveSettingsThen(() => true, newIntent)
  releaseOld(false)
  await oldRequest

  const dropped = vi.fn()
  await leaveSettingsThen(() => true, dropped)
  expect(dropped).not.toHaveBeenCalled()
  approveNew(true)
  await newRequest
  expect(newIntent).toHaveBeenCalledTimes(1)
})

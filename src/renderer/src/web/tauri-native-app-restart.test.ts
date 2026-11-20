import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from './testing/web-preload-api-test-harness'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT
} from '../../../shared/updater/updater-renderer-events'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke
}))

async function restartFixture() {
  const events = new EventTarget()
  const checkpoint = vi.fn(async () => {})
  const reload = vi.fn()
  const started = vi.fn()
  const aborted = vi.fn()
  events.addEventListener(ORCA_APP_RESTART_STARTED_EVENT, started)
  events.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, aborted)
  vi.stubGlobal(
    'window',
    Object.assign(events, {
      localStorage: new MemoryStorage(),
      location: { reload },
      api: { app: { awaitBeforeUnloadCheckpoint: checkpoint } }
    })
  )
  const { createTauriNativeAppApi } = await import('./tauri-native-platform-app-api')
  return { app: createTauriNativeAppApi(), events, checkpoint, reload, started, aborted }
}

describe('Tauri renderer restart lifecycle', () => {
  beforeEach(() => {
    native.invoke.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['reload', 'relaunch', 'restart'] as const)(
    'waits for the durable checkpoint before %s',
    async (action) => {
      const fixture = await restartFixture()
      const pending = Promise.withResolvers<void>()
      fixture.checkpoint.mockReturnValue(pending.promise)
      const staged = vi.fn()
      fixture.events.addEventListener('beforeunload', staged)

      const restarting = fixture.app[action]?.()
      await vi.waitFor(() => expect(fixture.checkpoint).toHaveBeenCalledOnce())
      expect(fixture.started).toHaveBeenCalledOnce()
      expect(staged).toHaveBeenCalledOnce()
      expect(native.invoke).not.toHaveBeenCalled()
      expect(fixture.reload).not.toHaveBeenCalled()

      pending.resolve()
      await restarting
      if (action === 'reload') {
        expect(fixture.reload).toHaveBeenCalledOnce()
        expect(native.invoke).not.toHaveBeenCalled()
      } else {
        expect(native.invoke).toHaveBeenCalledWith('poc_relaunch')
        expect(fixture.reload).not.toHaveBeenCalled()
      }
      expect(fixture.aborted).not.toHaveBeenCalled()
    }
  )

  it.each(['reload', 'relaunch', 'restart'] as const)(
    'refuses %s and releases preparation after a failed checkpoint',
    async (action) => {
      const fixture = await restartFixture()
      fixture.checkpoint.mockRejectedValueOnce(new Error('Checkpoint failed'))

      await expect(fixture.app[action]?.()).rejects.toThrow('Checkpoint failed')
      expect(fixture.aborted).toHaveBeenCalledOnce()
      expect(native.invoke).not.toHaveBeenCalled()
      expect(fixture.reload).not.toHaveBeenCalled()

      await fixture.app[action]?.()
      expect(fixture.checkpoint).toHaveBeenCalledTimes(2)
    }
  )

  it('unblocks the renderer when native shutdown refuses the restart', async () => {
    const fixture = await restartFixture()
    native.invoke.mockRejectedValueOnce(new Error('Runtime still saving'))
    await expect(fixture.app.restart?.()).rejects.toThrow('Runtime still saving')
    expect(fixture.aborted).toHaveBeenCalledOnce()
    await fixture.app.restart?.()
    expect(native.invoke).toHaveBeenCalledTimes(2)
  })

  it('refuses overlapping reload and restart preparations', async () => {
    const fixture = await restartFixture()
    const pending = Promise.withResolvers<void>()
    fixture.checkpoint.mockReturnValue(pending.promise)
    const restarting = fixture.app.restart?.()
    await expect(fixture.app.reload?.()).rejects.toThrow('already in progress')
    pending.resolve()
    await restarting
    expect(native.invoke).toHaveBeenCalledOnce()
    expect(fixture.reload).not.toHaveBeenCalled()
    expect(fixture.aborted).not.toHaveBeenCalled()
  })
})

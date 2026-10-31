import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore } from './store-test-helpers'

afterEach(() => vi.unstubAllGlobals())

it('acknowledges hold-to-quit locally without sending a new field to an older selected host', async () => {
  const current = { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'older-host' }
  const acknowledged = { ...current, holdQuitWhileAgentsWork: true }
  let resolve: (value: typeof acknowledged) => void = () => {}
  const response = new Promise<typeof acknowledged>((done) => {
    resolve = done
  })
  const settingsSet = vi.fn().mockReturnValue(response)
  const remoteCall = vi.fn(() => {
    throw new Error('Unknown strict remote setting')
  })
  const remoteStatus = vi.fn()
  vi.stubGlobal('window', {
    api: {
      settings: { set: settingsSet },
      runtimeEnvironments: { call: remoteCall, getStatus: remoteStatus }
    }
  })
  const store = createTestStore()
  store.setState({ settings: current })
  const pending = store.getState().updateSettingsOrThrow({ holdQuitWhileAgentsWork: true })
  expect(store.getState().settings?.holdQuitWhileAgentsWork).toBe(false)
  resolve(acknowledged)
  await pending
  expect(settingsSet).toHaveBeenCalledWith({ holdQuitWhileAgentsWork: true })
  expect(store.getState().settings?.holdQuitWhileAgentsWork).toBe(true)
  expect(remoteCall).not.toHaveBeenCalled()
  expect(remoteStatus).not.toHaveBeenCalled()
})

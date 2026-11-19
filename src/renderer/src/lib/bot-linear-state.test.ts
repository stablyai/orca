// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  awaitLinearChange,
  readBotLinear,
  readLinearAwait,
  refreshBotLinear
} from './bot-linear-state'

function signIn(userId: string): void {
  useAppStore.setState({
    orcaProfileAuthStatus: {
      activeProfileId: 'p',
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: { cloudProfileId: 'c', userId, email: 'e@x.dev', linkedAt: 1 }
    }
  })
}

const installUrl = 'https://connector.example/linear/install'
const linked = {
  workspaceId: 'org-1',
  name: 'Acme',
  urlKey: 'acme',
  installed: false,
  userId: 'L-me',
  userName: 'Dana',
  defaultBotId: null
}
const state = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  state.mockReset()
  Object.assign(window, { api: withBotConnectorRuntime({ botLinear: { state } }) })
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'api')
})

describe('bot Linear state', () => {
  it('reads a cloud that answers its Linear routes 404 as off', async () => {
    state.mockResolvedValue({ ok: false, error: 'linear_off' })
    expect(await refreshBotLinear('local')).toEqual({ status: 'off' })
  })

  it('polls while waiting until the links change, then stops', async () => {
    state.mockResolvedValue({ ok: true, value: { workspaces: [], installUrl } })
    await refreshBotLinear('local')
    await awaitLinearChange('local')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(state).toHaveBeenCalledTimes(2)

    state.mockResolvedValue({ ok: true, value: { workspaces: [linked], installUrl } })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(readBotLinear('local')).toMatchObject({ status: 'ready' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state).toHaveBeenCalledTimes(3)
  })

  it('reads at once when the owner comes back to Orca, e.g. after an admin installed', async () => {
    state.mockResolvedValue({ ok: true, value: { workspaces: [], installUrl } })
    await refreshBotLinear('local')
    await awaitLinearChange('local')
    expect(state).toHaveBeenCalledTimes(1)

    state.mockResolvedValue({ ok: true, value: { workspaces: [linked], installUrl } })
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(state).toHaveBeenCalledTimes(2)
    expect(readBotLinear('local')).toMatchObject({ status: 'ready' })
  })

  it('forgets the last account’s workspaces the moment another Orca account signs in', async () => {
    signIn('ada')
    state.mockResolvedValue({ ok: true, value: { workspaces: [linked], installUrl } })
    await refreshBotLinear('local')
    expect(readBotLinear('local')).toMatchObject({ status: 'ready' })

    signIn('bo')
    expect(readBotLinear('local')).toEqual({ status: 'loading' })
  })

  it('says nothing new came once the wait for an install runs out', async () => {
    state.mockResolvedValue({ ok: true, value: { workspaces: [linked], installUrl } })
    await refreshBotLinear('local')
    awaitLinearChange('local', 60_000)
    expect(readLinearAwait('local')).toBe('checking')
    await vi.advanceTimersByTimeAsync(70_000)
    expect(readLinearAwait('local')).toBe('unchanged')
  })
})

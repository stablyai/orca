// @vitest-environment happy-dom

import { withBotConnectorRuntime } from './bot-connector-host-calls.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  awaitLinearChange,
  readBotLinear,
  readLinearAwait,
  refreshBotLinear
} from './bot-linear-state'

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
  it('recognizes the same workspace’s install when the owner returns to Orca', async () => {
    state.mockResolvedValue({ ok: true, value: { workspaces: [linked], installUrl } })
    await refreshBotLinear('local')
    awaitLinearChange('local')
    expect(readLinearAwait('local')).toBe('checking')

    const installed = { ...linked, installed: true }
    state.mockResolvedValue({ ok: true, value: { workspaces: [installed], installUrl } })
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)

    expect(readBotLinear('local')).toEqual({
      status: 'ready',
      linear: { workspaces: [installed], installUrl }
    })
    expect(readLinearAwait('local')).toBeNull()
  })
})

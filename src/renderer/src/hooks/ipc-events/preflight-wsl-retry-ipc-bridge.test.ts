import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: {
    preflightStatusError: string | null
    refreshPreflightStatus: () => Promise<void>
    ensureDetectedAgents: () => Promise<unknown[]>
  } = {
    preflightStatusError: null,
    refreshPreflightStatus: vi.fn(async () => {}),
    ensureDetectedAgents: vi.fn(async () => [])
  }
  return { state }
})
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))

import { registerPreflightWslRetryIpcBridge } from './preflight-wsl-retry-ipc-bridge'

let emit: (distro: string) => void = () => {}

beforeEach(() => {
  mocks.state.preflightStatusError = null
  vi.mocked(mocks.state.refreshPreflightStatus).mockClear()
  vi.mocked(mocks.state.ensureDetectedAgents).mockClear()
  vi.stubGlobal('window', {
    api: {
      preflight: {
        onWslDistroRunning: (callback: (distro: string) => void) => {
          emit = callback
          return () => {}
        }
      }
    }
  })
})

it('re-asks refused integration checks and agent detection once the distro runs (E9)', () => {
  mocks.state.preflightStatusError = "WSL distro 'Ubuntu' is not running."
  registerPreflightWslRetryIpcBridge([])
  emit('Ubuntu')
  expect(mocks.state.refreshPreflightStatus).toHaveBeenCalledOnce()
  expect(mocks.state.ensureDetectedAgents).toHaveBeenCalledOnce()
})

it('leaves a healthy integration status alone', () => {
  registerPreflightWslRetryIpcBridge([])
  emit('Ubuntu')
  expect(mocks.state.refreshPreflightStatus).not.toHaveBeenCalled()
  expect(mocks.state.ensureDetectedAgents).toHaveBeenCalledOnce()
})

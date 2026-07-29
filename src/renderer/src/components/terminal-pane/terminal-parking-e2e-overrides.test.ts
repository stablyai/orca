import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockE2EConfig = { exposeStore: boolean; terminalParkingDelayMs: number | null }

let mockE2EConfig: MockE2EConfig

vi.mock('@/lib/e2e-config', () => ({
  get e2eConfig() {
    return mockE2EConfig
  }
}))

vi.mock('./terminal-parked-tab-watchers', () => ({
  getParkedTerminalWatcherTabIds: () => ['tab-parked']
}))

const originalWindow = (globalThis as { window?: unknown }).window

type TerminalParkingE2EOverridesModule = {
  getTerminalParkingPolicyOverrides: () => {
    coldParkDelayMs?: number
    hotRetainMs?: number
    hotRetainLimit?: number
  }
  registerTerminalParkingDebugHandle: () => void
}

async function importOverridesModule(): Promise<TerminalParkingE2EOverridesModule> {
  vi.resetModules()
  return import('./terminal-parking-e2e-overrides')
}

describe('getTerminalParkingPolicyOverrides', () => {
  beforeEach(() => {
    mockE2EConfig = { exposeStore: false, terminalParkingDelayMs: null }
    delete (globalThis as { window?: unknown }).window
  })

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  it('ignores the delay override outside e2e (exposeStore off)', async () => {
    mockE2EConfig = { exposeStore: false, terminalParkingDelayMs: 500 }
    const { getTerminalParkingPolicyOverrides } = await importOverridesModule()
    expect(getTerminalParkingPolicyOverrides()).toEqual({})
  })

  it('maps the e2e delay to BOTH coldParkDelayMs and hotRetainMs', async () => {
    mockE2EConfig = { exposeStore: true, terminalParkingDelayMs: 500 }
    const { getTerminalParkingPolicyOverrides } = await importOverridesModule()
    expect(getTerminalParkingPolicyOverrides()).toEqual({
      coldParkDelayMs: 500,
      hotRetainMs: 500
    })
  })

  it('returns no overrides when no delay is configured', async () => {
    mockE2EConfig = { exposeStore: true, terminalParkingDelayMs: null }
    const { getTerminalParkingPolicyOverrides } = await importOverridesModule()
    expect(getTerminalParkingPolicyOverrides()).toEqual({})
  })

  it('registers window.__terminalParkingDebug on import under exposeStore', async () => {
    mockE2EConfig = { exposeStore: true, terminalParkingDelayMs: 500 }
    const testWindow: {
      __terminalParkingDebug?: { parkDelayMs: number; parkedTabIds: () => string[] }
    } = {}
    ;(globalThis as { window?: unknown }).window = testWindow
    await importOverridesModule()
    expect(testWindow.__terminalParkingDebug?.parkDelayMs).toBe(500)
    expect(testWindow.__terminalParkingDebug?.parkedTabIds()).toEqual(['tab-parked'])
  })

  it('does not register the debug handle outside e2e', async () => {
    mockE2EConfig = { exposeStore: false, terminalParkingDelayMs: null }
    const testWindow: { __terminalParkingDebug?: unknown } = {}
    ;(globalThis as { window?: unknown }).window = testWindow
    await importOverridesModule()
    expect(testWindow.__terminalParkingDebug).toBeUndefined()
  })
})

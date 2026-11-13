// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ stop: vi.fn(), run: vi.fn(), reload: vi.fn() }))
const hold = vi.hoisted(() => ({ release: vi.fn(), start: vi.fn(async () => 'held') }))

vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  runOrcaCloudAgentSetups: store.run,
  stopOrcaCloudAgentSetups: store.stop,
  reloadOrcaCloudAgentAccounts: store.reload
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({
  releaseCloudAgentHold: hold.release,
  startCloudAgentHold: hold.start
}))

// The strip reads the agents bridge at build time; these tests never reach it.
Object.defineProperty(window, 'api', { value: { orcaCloudAgents: {} }, configurable: true })

const { cloudSetupStripActions } = await import('./cloud-setup-strip-actions')

function actions(setupRunning: boolean) {
  return cloudSetupStripActions({
    agent: 'claude',
    holdKey: 'tab:1',
    setupRunning,
    copyText: vi.fn(),
    openLink: vi.fn(),
    useApiKey: vi.fn()
  })
}

describe('cloudSetupStripActions (PC-3b, RR-a)', () => {
  beforeEach(() => {
    store.stop.mockReset()
    hold.release.mockReset()
    hold.start.mockClear()
  })

  it('Cancel during a setup stops only the setup: the launch stays held', () => {
    actions(true).cancel()
    expect(store.stop).toHaveBeenCalledExactlyOnceWith('claude')
    expect(hold.release).not.toHaveBeenCalled()
  })

  it('Cancel with no setup running gives up the held launch (plain shell)', () => {
    actions(false).cancel()
    expect(store.stop).not.toHaveBeenCalled()
    expect(hold.release).toHaveBeenCalledExactlyOnceWith('tab:1', 'cancel')
  })

  it('Start re-checks the account before it releases the held launch (HELD-STALE-COVERED)', () => {
    actions(false).primary({ kind: 'start' })
    expect(hold.start).toHaveBeenCalledExactlyOnceWith('tab:1')
    expect(hold.release).not.toHaveBeenCalled()
  })
})

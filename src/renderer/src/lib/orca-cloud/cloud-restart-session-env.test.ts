import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted((): { cloud: boolean; ptyId: string | null } => ({
  cloud: true,
  ptyId: 'remote:env-1@@term_1'
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      terminalLayoutsByTabId: { t1: { ptyIdsByLeafId: { l1: state.ptyId } } }
    })
  }
}))
vi.mock('./orca-cloud-environment-id', () => ({ isOrcaCloudEnvironmentId: () => state.cloud }))

const { withOrcaCloudSessionEnv, ORCA_CLOUD_SESSION_ENV_REFRESH } =
  await import('./cloud-restart-session-env')
const PANE = { tabId: 't1', leafId: 'l1' }

describe('withOrcaCloudSessionEnv (RA-11 restart)', () => {
  it('refreshes the cloud shell’s session env before the relaunch, once', () => {
    const out = withOrcaCloudSessionEnv({ command: "claude '--resume' 's1'", x: 1 }, PANE)
    expect(out).toEqual({
      command: `${ORCA_CLOUD_SESSION_ENV_REFRESH}claude '--resume' 's1'`,
      x: 1
    })
    expect(withOrcaCloudSessionEnv(out, PANE)).toBe(out)
  })

  it('leaves other hosts and local panes alone', () => {
    state.cloud = false
    const startup = { command: 'claude' }
    expect(withOrcaCloudSessionEnv(startup, PANE)).toBe(startup)
    state.cloud = true
    state.ptyId = null
    expect(withOrcaCloudSessionEnv(startup, PANE)).toBe(startup)
  })
})

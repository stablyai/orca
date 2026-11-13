// @vitest-environment happy-dom
// Mounts the real Orca Cloud running-agent strip portal in each state it renders (expired,
// restarting, started a new conversation), so a missing import or a broken branch fails here and
// never first on a real-app run. The account, restart and store reads are stubbed per state.
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'

const stub = vi.hoisted(() => {
  const state: {
    strip: { phase: 'expired'; agent: 'claude' } | null
    attempt: {
      phase: 'restarting' | 'failed'
      agent: 'claude'
      resumable: boolean
      ptyId: string
      launchedAt: number | null
    } | null
    startedFresh: boolean
    tabHeld: boolean
  } = { strip: null, attempt: null, startedFresh: false, tabHeld: false }
  return state
})

vi.mock('@/store', () => {
  const state = {
    terminalLayoutsByTabId: {
      'tab-1': { ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': 'pty-1' } }
    },
    agentStatusByPaneKey: new Proxy(
      {},
      { get: () => ({ agentType: 'claude', state: 'done', mainAgent: true }) }
    ),
    openSettingsTarget: () => undefined,
    openSettingsPage: () => undefined,
    queuePaneAccountRestarts: () => undefined
  }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'env-cloud'
}))
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => true
}))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  orcaCloudAgentAccountsLoadedAt: () => 0,
  useOrcaCloudAgentAccounts: () => ({
    load: { kind: 'loading' },
    keyKinds: {},
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } }
  }),
  runOrcaCloudAgentSetups: () => undefined,
  stopOrcaCloudAgentSetups: () => undefined,
  reloadOrcaCloudAgentAccounts: async () => undefined
}))
vi.mock('@/lib/orca-cloud/cloud-running-agent-signout', () => ({
  clearCloudRunningSignout: () => undefined,
  cloudRunningStrip: (args: { held: boolean }) => (args.held ? null : stub.strip),
  useCloudRunningAccountReads: () => undefined,
  useCloudRunningSignoutVersion: () => 0,
  useWorkspaceUsesAccount: () => true
}))
vi.mock('@/lib/orca-cloud/cloud-agent-restart-attempt', () => ({
  beginCloudAgentRestart: () => undefined,
  cloudAgentRestartAttempt: () => stub.attempt,
  cloudAgentRestartStartedFresh: () => stub.startedFresh,
  dismissCloudAgentRestart: () => undefined,
  settleCloudAgentRestart: () => undefined
}))
vi.mock('@/lib/orca-cloud/cloud-agent-restart-pane-watch', () => ({
  watchCloudAgentRestartPane: () => undefined
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({
  cloudTabHoldKey: (tabId: string) => `tab:${tabId}`,
  useCloudAgentHold: (key: string) =>
    stub.tabHeld && key === 'tab:tab-1' ? { agent: 'claude', reason: 'accountExpired' } : null
}))
vi.mock('@/lib/agent-sign-in/agent-sign-in-gate-store', () => ({ useAgentSignInGate: () => null }))

const { CloudRunningStripPortal } = await import('./CloudRunningStripPortal')
const { CloudChatBannerSlot } = await import('./CloudChatBannerSlot')
const { resetCloudChatBannerSlotsForTest } = await import('./cloud-chat-banner-slot')

/** chatOpen: the tab's chat view covers the pane, so the strip shows in its column (CHAT-BANNERS). */
function mount(chatOpen = false): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const leafId = '11111111-1111-4111-8111-111111111111'
  if (!isTerminalLeafId(leafId)) {
    throw new Error('test leaf id must be a terminal leaf id')
  }
  const pane: Pick<ManagedPane, 'id' | 'leafId' | 'container'> = { id: 1, leafId, container }
  render(
    <TooltipProvider>
      {chatOpen ? <CloudChatBannerSlot paneKey={`tab-1:${leafId}`} /> : null}
      {/* oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portal reads only id, leafId and container from the pane. */}
      <CloudRunningStripPortal pane={pane as ManagedPane} tabId="tab-1" worktreeId="wt-1" />
    </TooltipProvider>
  )
  return container
}

beforeEach(() => {
  stub.strip = null
  stub.attempt = null
  stub.startedFresh = false
  stub.tabHeld = false
})
afterEach(() => {
  cleanup()
  resetCloudChatBannerSlotsForTest()
  document.body.innerHTML = ''
})

describe('CloudRunningStripPortal renders every state', () => {
  it('expired: the account-recovery strip with Renew', () => {
    stub.strip = { phase: 'expired', agent: 'claude' }
    mount()
    expect(screen.getAllByText(/Claude sign-in expired/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Renew/ })).toBeTruthy()
  })

  it('restarting: the neutral "Restarting Claude…" line', () => {
    stub.attempt = {
      phase: 'restarting',
      agent: 'claude',
      resumable: true,
      ptyId: 'pty-1',
      launchedAt: null
    }
    mount()
    expect(screen.getAllByText(/Restarting Claude…/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Picking up where you left off/)).toBeNull()
  })

  it('started fresh: "Started a new conversation."', () => {
    stub.startedFresh = true
    mount()
    expect(screen.getAllByText(/Started a new conversation\./).length).toBeGreaterThan(0)
  })
})

describe('CloudRunningStripPortal in the chat view (CHAT-BANNERS)', () => {
  const chatColumn = (): HTMLElement => {
    const container = mount(true)
    expect(container.textContent).toBe('')
    return document.querySelector<HTMLElement>('[data-cloud-chat-banners]')!
  }

  it('expired: Renew, in the chat column', () => {
    stub.strip = { phase: 'expired', agent: 'claude' }
    const slot = chatColumn()
    expect(within(slot).getByRole('button', { name: /Renew/ })).toBeTruthy()
  })

  it('restarting', () => {
    stub.attempt = {
      phase: 'restarting',
      agent: 'claude',
      resumable: true,
      ptyId: 'pty-1',
      launchedAt: null
    }
    expect(within(chatColumn()).getAllByText(/Restarting Claude…/).length).toBeGreaterThan(0)
  })

  it("couldn't restart", () => {
    stub.attempt = {
      phase: 'failed',
      agent: 'claude',
      resumable: true,
      ptyId: 'pty-1',
      launchedAt: null
    }
    expect(within(chatColumn()).getAllByText(/Couldn’t restart Claude/).length).toBeGreaterThan(0)
  })

  it('started fresh', () => {
    stub.startedFresh = true
    expect(
      within(chatColumn()).getAllByText(/Started a new conversation\./).length
    ).toBeGreaterThan(0)
  })
})

describe('DUP-EXPIRED-STRIP', () => {
  it('a launch held on the whole tab shows only its own strip, never this one beside it', () => {
    stub.strip = { phase: 'expired', agent: 'claude' }
    stub.tabHeld = true
    const container = mount()
    expect(container.textContent).toBe('')
  })
})

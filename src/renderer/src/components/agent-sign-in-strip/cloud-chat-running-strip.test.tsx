// @vitest-environment happy-dom
// CHAT-BANNERS B2: RA-11's running strip on a structured chat. Expired shows Renew; renewed confirms
// with no Restart (the chat's next message uses the renewed sign-in) and its × dismisses; a held
// launch's strip wins over it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const TAB_ID = 'structured-agent-session-claude_1'
const STATUS_KEY = `${TAB_ID}:5b1d2c3e-aaaa-4bbb-accc-0123456789ab`
const HOLD_KEY = `${TAB_ID}:11111111-2222-4333-a444-555555555555`

type Strip =
  | { phase: 'expired'; agent: 'claude' }
  | { phase: 'renewed'; agent: 'claude'; resumable: boolean }

const stub = vi.hoisted(() => {
  const state: {
    strip: Strip | null
    held: boolean
    cleared: string[]
    calls: { paneKey: string; turnEndedFallback?: boolean }[]
    openedSettings: number
  } = { strip: null, held: false, cleared: [], calls: [], openedSettings: 0 }
  return state
})

vi.mock('@/store', () => {
  const state = {
    unifiedTabsByWorktree: {
      'wt-1': [{ id: TAB_ID, executionHostId: 'runtime:env-cloud', contentType: 'agent-session' }]
    },
    agentStatusByPaneKey: {
      [STATUS_KEY]: { agentType: 'claude', state: 'working', paneKey: STATUS_KEY }
    },
    openSettingsTarget: () => undefined,
    openSettingsPage: () => {
      stub.openedSettings += 1
    }
  }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: (id: string) => id === 'env-cloud'
}))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  orcaCloudAgentAccountsLoadedAt: () => 1,
  useOrcaCloudAgentAccounts: () => ({
    load: { kind: 'loading' },
    keyKinds: {},
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } }
  })
}))
vi.mock('@/lib/orca-cloud/cloud-running-agent-signout', () => ({
  clearCloudRunningSignout: (key: string) => {
    stub.cleared.push(key)
  },
  cloudRunningStrip: (args: { paneKey: string; held: boolean; turnEndedFallback?: boolean }) => {
    stub.calls.push({ paneKey: args.paneKey, turnEndedFallback: args.turnEndedFallback })
    return args.held ? null : stub.strip
  },
  useCloudRunningAccountReads: () => undefined,
  useCloudRunningSignoutVersion: () => 0,
  useWorkspaceUsesAccount: () => true
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCloudAgentHold: (key: string) =>
    key === HOLD_KEY && stub.held ? { agent: 'claude', reason: 'notSetUp', prompt: null } : null,
  readCloudAgentHold: () => null
}))
vi.mock('@/lib/agent-sign-in/agent-sign-in-gate-store', () => ({ useAgentSignInGate: () => null }))
vi.mock('../agent-sign-in/AgentSignInPanePortals', () => ({
  agentSignInCardActions: () => ({
    copyText: () => undefined,
    openLink: () => undefined,
    signIn: () => undefined,
    retry: () => undefined,
    useCode: () => undefined,
    submitCode: () => undefined,
    cancel: () => undefined
  })
}))
Object.defineProperty(window, 'api', { configurable: true, value: { orcaCloudAgents: {} } })
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
)

const { CloudStructuredChatBanners } = await import('./CloudStructuredChatBanners')

const mount = () =>
  render(
    <TooltipProvider>
      <CloudStructuredChatBanners tabId={TAB_ID} paneKey={HOLD_KEY} statusKey={STATUS_KEY} />
    </TooltipProvider>
  )

beforeEach(() => {
  stub.strip = null
  stub.held = false
  stub.cleared = []
  stub.calls = []
  stub.openedSettings = 0
})
afterEach(() => cleanup())

describe('the running strip on a structured chat (B2)', () => {
  it('expired: "sign-in expired" with Renew, read through the chat status key', () => {
    stub.strip = { phase: 'expired', agent: 'claude' }
    mount()
    expect(screen.getAllByText(/Claude sign-in expired/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Renew/ }))
    expect(stub.openedSettings).toBe(1)
    expect(stub.calls.at(-1)).toEqual({ paneKey: STATUS_KEY, turnEndedFallback: true })
  })

  it('renewed: confirms with no Restart, and × dismisses it', () => {
    stub.strip = { phase: 'renewed', agent: 'claude', resumable: true }
    mount()
    expect(screen.getAllByText(/Claude sign-in renewed/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Your next message uses it/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(stub.cleared).toEqual([STATUS_KEY])
  })

  it("a held launch's strip shows instead", () => {
    stub.strip = { phase: 'expired', agent: 'claude' }
    stub.held = true
    mount()
    expect(screen.getByRole('button', { name: 'Set up once' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Renew/ })).toBeNull()
  })
})

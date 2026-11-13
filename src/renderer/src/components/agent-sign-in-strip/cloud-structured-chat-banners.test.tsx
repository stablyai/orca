// @vitest-environment happy-dom
// CHAT-BANNERS (PR-B): a structured chat shows its held launch's strip at the top of its column (the
// terminal pane's strip, same copy and actions), and a chat closed while held gives up its launch.
import { act } from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type * as LaunchHoldModule from '@/lib/orca-cloud/cloud-agent-launch-hold'

const stub = vi.hoisted(() => {
  const state: {
    hold: { agent: 'claude'; reason: 'notSetUp' | 'accountExpired'; prompt: string | null } | null
    setup: OrcaCloudAgentSetup
    openTabIds: string[]
    released: [string, string][]
    stopped: string[]
  } = { hold: null, setup: { phase: 'idle' }, openTabIds: [], released: [], stopped: [] }
  return state
})

vi.mock('@/store', () => {
  const useAppStore = (selector: (s: unknown) => unknown): unknown => selector({})
  useAppStore.getState = () => ({
    unifiedTabsByWorktree: { 'wt-1': stub.openTabIds.map((id) => ({ id })) },
    openSettingsTarget: () => undefined,
    openSettingsPage: () => undefined
  })
  return { useAppStore }
})
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchHoldModule>()),
  useCloudAgentHold: (key: string) => (key === PANE_KEY ? stub.hold : null),
  readCloudAgentHold: () => stub.hold,
  releaseCloudAgentHold: (key: string, outcome: string) => {
    stub.released.push([key, outcome])
  }
}))
vi.mock('@/lib/agent-sign-in/agent-sign-in-gate-store', () => ({
  useAgentSignInGate: () => null
}))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  stopOrcaCloudAgentSetups: (agent: string) => {
    stub.stopped.push(agent)
  },
  orcaCloudAgentAccountsLoadedAt: () => 0,
  useOrcaCloudAgentAccounts: () => ({
    load: { kind: 'loading' },
    keyKinds: {},
    setups: { claude: stub.setup, codex: { phase: 'idle' } }
  })
}))
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

const TAB_ID = 'structured-agent-session-claude_1'
const PANE_KEY = `${TAB_ID}:5b1d2c3e-aaaa-4bbb-accc-0123456789ab`
const { CloudStructuredChatBanners } = await import('./CloudStructuredChatBanners')

const mount = () =>
  render(
    <TooltipProvider>
      <CloudStructuredChatBanners tabId={TAB_ID} paneKey={PANE_KEY} statusKey={PANE_KEY} />
    </TooltipProvider>
  )

beforeEach(() => {
  vi.useFakeTimers()
  stub.hold = null
  stub.setup = { phase: 'idle' }
  stub.openTabIds = [TAB_ID]
  stub.released = []
  stub.stopped = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the structured chat strip', () => {
  it('Claude not set up: "Set up once" at the top of the chat', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    const view = mount()
    const slot = view.container.querySelector<HTMLElement>('[data-cloud-chat-banners]')!
    expect(within(slot).getByRole('button', { name: 'Set up once' })).toBeTruthy()
  })

  it('the paste-code step', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    stub.setup = { phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true }
    const view = mount()
    expect(within(view.container).getByLabelText('Code from Claude’s sign-in page')).toBeTruthy()
  })

  it('sign-in expired: Renew', () => {
    stub.hold = { agent: 'claude', reason: 'accountExpired', prompt: null }
    const view = mount()
    expect(within(view.container).getByRole('button', { name: /Renew/ })).toBeTruthy()
  })

  it('nothing held: an empty slot, no strip', () => {
    const view = mount()
    expect(view.container.querySelector('[data-cloud-chat-banners]')?.textContent).toBe('')
  })

  it('CHAT-CANCEL-ERROR: a held chat has no × and Escape keeps it held on its strip', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    const view = mount()
    const slot = view.container.querySelector<HTMLElement>('[data-cloud-chat-banners]')!
    expect(within(slot).queryByRole('button', { name: /Cancel sign-in/ })).toBeNull()
    fireEvent.keyDown(slot.querySelector('[data-cloud-sign-in-strip]')!, { key: 'Escape' })
    expect(stub.released).toEqual([])
    expect(within(slot).getByRole('button', { name: 'Set up once' })).toBeTruthy()
  })

  it('CHAT-CANCEL-ERROR: an expired held chat keeps its hold on Escape too', () => {
    stub.hold = { agent: 'claude', reason: 'accountExpired', prompt: null }
    const view = mount()
    const strip = view.container.querySelector<HTMLElement>('[data-cloud-sign-in-strip]')!
    fireEvent.keyDown(strip, { key: 'Escape' })
    expect(stub.released).toEqual([])
  })

  it('CHAT-CANCEL-ERROR: during a setup, Cancel stops only the sign-in; the chat stays held', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    stub.setup = { phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true }
    const view = mount()
    const strip = view.container.querySelector<HTMLElement>('[data-cloud-sign-in-strip]')!
    fireEvent.keyDown(strip, { key: 'Escape' })
    expect(stub.stopped).toEqual(['claude'])
    expect(stub.released).toEqual([])
  })

  it('a chat closed while held cancels its launch; a remount keeps it', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    mount().unmount()
    act(() => vi.advanceTimersByTime(1_000))
    expect(stub.released).toEqual([])
    stub.openTabIds = []
    mount().unmount()
    act(() => vi.advanceTimersByTime(1_000))
    expect(stub.released).toEqual([[PANE_KEY, 'cancel']])
  })
})

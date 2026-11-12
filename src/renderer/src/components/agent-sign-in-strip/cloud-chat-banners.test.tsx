// @vitest-environment happy-dom
// CHAT-BANNERS (PR-A): a terminal tab's chat view covers its pane, so the pane's cloud banners move
// into the chat column's slot while it is open: one copy, in whichever view is on. Mounts the real
// held-launch strip (Set up once, its paste states, Renew) and the woke-up agent bar in both places.
import { act } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Translate } from '@/i18n/use-translate'
import { AGENT_RELAUNCH_GRACE_MS } from '@/lib/orca-cloud/cloud-woke-agent-strip'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type * as LaunchHoldModule from '@/lib/orca-cloud/cloud-agent-launch-hold'

const stub = vi.hoisted(() => {
  const state: {
    hold: { agent: 'claude'; reason: 'notSetUp' | 'accountExpired'; prompt: string | null } | null
    setup: OrcaCloudAgentSetup
  } = { hold: null, setup: { phase: 'idle' } }
  return state
})

vi.mock('@/store', () => {
  const state = {
    agentStatusByPaneKey: {},
    openSettingsTarget: () => undefined,
    openSettingsPage: () => undefined
  }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchHoldModule>()),
  useCloudAgentHold: (key: string) => (key.startsWith('tab-1:') ? stub.hold : null),
  readCloudAgentHold: () => stub.hold,
  releaseCloudAgentHold: () => undefined
}))
vi.mock('@/lib/agent-sign-in/agent-sign-in-gate-store', () => ({
  useAgentSignInGate: () => null,
  readAgentSignInGate: () => null,
  subscribeAgentSignInGates: () => () => undefined
}))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
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
vi.mock('./CloudRunningStripPortal', () => ({ CloudRunningStripPortal: () => null }))
// The setup strip's actions read the preload API when they are built; nothing calls them here.
Object.defineProperty(window, 'api', { configurable: true, value: { orcaCloudAgents: {} } })
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
)

const { CloudAgentSignInStripPortals } = await import('./CloudAgentSignInStripPortals')
const { CloudPaneBannerPortal } = await import('./CloudPaneBannerPortal')
const { CloudChatBannerSlot } = await import('./CloudChatBannerSlot')
const { resetCloudChatBannerSlotsForTest } = await import('./cloud-chat-banner-slot')
const { CloudWokeAgentNotice } =
  await import('@/components/orca-cloud/offline/CloudWokeAgentNotice')
const { cloudChatHoldHint } = await import('./use-cloud-chat-hold-hint')

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF}`

function makePane(): { pane: ManagedPane; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  if (!isTerminalLeafId(LEAF)) {
    throw new Error('test leaf id must be a terminal leaf id')
  }
  const pane: Pick<ManagedPane, 'id' | 'leafId' | 'container'> = { id: 1, leafId: LEAF, container }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portals read only id, leafId and container from the pane.
  return { pane: pane as ManagedPane, container }
}

function controllerFor(pane: ManagedPane): TerminalPaneController {
  const fields = { managedPanes: [pane], tabId: 'tab-1', worktreeId: 'wt-1' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portals read only managedPanes, tabId and worktreeId.
  return fields as unknown as TerminalPaneController
}

/** The pane's portals, with or without the chat view's column (its slot) open over the pane. */
function mountStrips(chatOpen: boolean): { container: HTMLElement; slot: HTMLElement | null } {
  const { pane, container } = makePane()
  render(
    <TooltipProvider>
      {chatOpen ? <CloudChatBannerSlot paneKey={PANE_KEY} /> : null}
      <CloudAgentSignInStripPortals controller={controllerFor(pane)} />
    </TooltipProvider>
  )
  return { container, slot: document.querySelector('[data-cloud-chat-banners]') }
}

beforeEach(() => {
  stub.hold = null
  stub.setup = { phase: 'idle' }
})
afterEach(() => {
  cleanup()
  resetCloudChatBannerSlotsForTest()
  document.body.innerHTML = ''
})

describe('CloudPaneBannerPortal', () => {
  it('shows in the pane, in the strip layer, while the pane shows its terminal', () => {
    const { pane, container } = makePane()
    render(
      <CloudPaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k" stripLayer>
        <p>banner</p>
      </CloudPaneBannerPortal>
    )
    expect(container.querySelector('[data-cloud-strip-layer]')?.textContent).toBe('banner')
  })

  it('moves to the chat column while the chat view is open, and back when it closes', () => {
    const { pane, container } = makePane()
    const view = (chatOpen: boolean) => (
      <>
        {chatOpen ? <CloudChatBannerSlot paneKey={PANE_KEY} /> : null}
        <CloudPaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k" stripLayer>
          <p>banner</p>
        </CloudPaneBannerPortal>
      </>
    )
    const { rerender } = render(view(true))
    const slot = document.querySelector('[data-cloud-chat-banners]')
    expect(slot?.textContent).toBe('banner')
    expect(container.textContent).toBe('')
    expect(screen.getAllByText('banner')).toHaveLength(1)
    rerender(view(false))
    expect(container.querySelector('[data-cloud-strip-layer]')?.textContent).toBe('banner')
    expect(screen.getAllByText('banner')).toHaveLength(1)
  })

  it("never shows another pane's chat column", () => {
    const { pane, container } = makePane()
    render(
      <>
        <CloudChatBannerSlot paneKey="tab-1:other-leaf" />
        <CloudPaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="k">
          <p>banner</p>
        </CloudPaneBannerPortal>
      </>
    )
    expect(container.textContent).toBe('banner')
    expect(document.querySelector('[data-cloud-chat-banners]')?.textContent).toBe('')
  })
})

describe('the held-launch strip in the chat view', () => {
  const inChat = (): HTMLElement => {
    const { container, slot } = mountStrips(true)
    expect(container.textContent).toBe('')
    expect(slot).not.toBeNull()
    return slot!
  }

  it('not set up: "Set up once"', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: 'fix the flaky test' }
    const slot = inChat()
    expect(within(slot).getByRole('button', { name: 'Set up once' })).toBeTruthy()
  })

  it('setup in the browser: the paste-code field', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    stub.setup = { phase: 'browser', startedAt: 0, canReopen: true, acceptsCode: true }
    const slot = inChat()
    expect(within(slot).getByLabelText('Code from Claude’s sign-in page')).toBeTruthy()
  })

  it('a rejected code: the field stays, with the refusal', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    stub.setup = { phase: 'browser', startedAt: 0, canReopen: false, code: 'rejected' }
    const slot = inChat()
    expect(within(slot).getByLabelText('Code from Claude’s sign-in page')).toBeTruthy()
    expect(
      within(slot).getByText('Paste the newest code from the sign-in page, or open it again.')
    ).toBeTruthy()
  })

  it('sign-in expired: Renew', () => {
    stub.hold = { agent: 'claude', reason: 'accountExpired', prompt: null }
    const slot = inChat()
    expect(within(slot).getByRole('button', { name: /Renew/ })).toBeTruthy()
  })

  it('with the chat view closed, the same strip is in the pane', () => {
    stub.hold = { agent: 'claude', reason: 'notSetUp', prompt: null }
    const { container, slot } = mountStrips(false)
    expect(slot).toBeNull()
    expect(within(container).getByRole('button', { name: 'Set up once' })).toBeTruthy()
  })
})

describe('the woke-up bar in the chat view', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the agent variant shows Restart Claude in the chat column, and no Rerun', () => {
    const { pane, container } = makePane()
    const onRestart = vi.fn()
    render(
      <>
        <CloudChatBannerSlot paneKey={PANE_KEY} />
        <CloudPaneBannerPortal pane={pane} paneKey={PANE_KEY} portalKey="woke">
          <CloudWokeAgentNotice
            paneKey={PANE_KEY}
            paneLeafId={LEAF}
            agentName="Claude"
            capturedAt={1_000}
            paneAtShellPrompt={() => true}
            subscribeScreen={() => () => undefined}
            onRestart={onRestart}
            onDismiss={() => undefined}
          />
        </CloudPaneBannerPortal>
      </>
    )
    act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_GRACE_MS))
    const slot = document.querySelector<HTMLElement>('[data-cloud-chat-banners]')!
    within(slot).getByRole('button', { name: 'Restart Claude' }).click()
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(within(slot).queryByRole('button', { name: /Rerun/ })).toBeNull()
    expect(container.textContent).toBe('')
  })
})

describe('the chat composer while a cloud launch is held', () => {
  const t: Translate = (_key, fallback, options) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''))

  it('points at the strip above it', () => {
    expect(cloudChatHoldHint({ agent: 'claude', reason: 'notSetUp' }, null, t)).toBe(
      'Set up Claude above to start'
    )
    expect(cloudChatHoldHint({ agent: 'claude', reason: 'accountExpired' }, null, t)).toBe(
      'Renew Claude sign-in above to start'
    )
  })

  it('says nothing (and blocks nothing) without a hold or a cloud gate', () => {
    expect(cloudChatHoldHint(null, null, t)).toBeUndefined()
    expect(
      cloudChatHoldHint(null, { agent: 'claude', environmentId: 'ssh-host-1' }, t)
    ).toBeUndefined()
  })
})

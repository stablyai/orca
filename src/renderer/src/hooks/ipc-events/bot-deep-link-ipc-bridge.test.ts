import { withBotConnectorRuntime } from '../../lib/bot-connector-host-calls.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDeepLinkOutcome } from '../../../../shared/bot-deep-link'
import { registerBotDeepLinkIpcBridge } from './bot-deep-link-ipc-bridge'

const mocks = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  activateChat: vi.fn(async () => true),
  openBotLinkHome: vi.fn(async () => {}),
  redeem: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  setupOpen: vi.fn(() => false),
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn(),
  subscribe: vi.fn<(listener: (state: { workspaceSessionReady: boolean }) => void) => () => void>()
}))

let storeState: { workspaceSessionReady: boolean }

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      ...storeState,
      openSettingsTarget: mocks.openSettingsTarget,
      openSettingsPage: mocks.openSettingsPage
    }),
    subscribe: mocks.subscribe
  }
}))
vi.mock('@/lib/connector-connect-state', () => ({ redeemConnectorLink: mocks.redeem }))
vi.mock('@/components/bots/linear/bot-linear-copy', () => ({
  botLinearErrorMessage: (code: string) => `linear:${code}`
}))
vi.mock('@/components/bots/github/bot-github-copy', () => ({
  botGitHubErrorMessage: (code: string) => `github:${code}`
}))
vi.mock('@/lib/connector-setup-open', () => ({ isConnectorSetupOpen: mocks.setupOpen }))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat
}))
vi.mock('@/lib/bot-link-open', () => ({
  openBotLinkHome: mocks.openBotLinkHome,
  openAccessRequestLink: vi.fn()
}))
vi.mock('@/lib/bot-access-requests', () => ({ watchAccessRequests: () => () => {} }))
vi.mock('sonner', () => ({
  toast: { info: mocks.toastInfo, success: mocks.toastSuccess, error: mocks.toastError }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const MISSING = "That conversation isn't open on this computer."

/** Main's single pending link, answered once per pull, and its doorbell. */
function stubPreload(pending: BotDeepLinkOutcome | null) {
  let ring: (() => void) | null = null
  let queued = pending
  const consume = vi.fn(async () => {
    const outcome = queued
    queued = null
    return outcome
  })
  vi.stubGlobal('window', {
    api: withBotConnectorRuntime({
      ui: {
        onBotLinkPending: (callback: () => void) => {
          ring = callback
          return () => {}
        },
        consumePendingBotLink: consume
      }
    })
  })
  return {
    consume,
    deliver: (outcome: BotDeepLinkOutcome) => {
      queued = outcome
      ring?.()
    }
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('registerBotDeepLinkIpcBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState = { workspaceSessionReady: true }
    mocks.subscribe.mockReset().mockReturnValue(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves a cold-start link in main until startup restoration has finished', async () => {
    storeState.workspaceSessionReady = false
    const { consume } = stubPreload({ kind: 'missing' })

    registerBotDeepLinkIpcBridge([])
    await settle()
    expect(consume).not.toHaveBeenCalled()

    storeState.workspaceSessionReady = true
    mocks.subscribe.mock.calls[0][0](storeState)
    await settle()
    // Once for the link, once more to find nothing else waiting.
    expect(consume).toHaveBeenCalledTimes(2)
    expect(mocks.toastInfo).toHaveBeenCalledWith(MISSING)
  })

  it('pulls a link that arrives while Orca is open, once', async () => {
    // Pulls: on register (nothing), the link, then nothing left.
    const { consume, deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'home', botId: 'b1' })
    await settle()

    expect(consume).toHaveBeenCalledTimes(3)
    expect(mocks.openBotLinkHome).toHaveBeenCalledOnce()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it("says so when main could not open the link's conversation", async () => {
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'missing' })
    await settle()

    expect(mocks.toastInfo).toHaveBeenCalledWith(MISSING)
  })

  it('opens a native chat through the shared chat path', async () => {
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'chat', workspaceId: 'repo::/w', sessionId: 'chat-1' })
    await settle()

    expect(mocks.activateChat).toHaveBeenCalledWith(
      { structuredSession: { workspaceId: 'repo::/w', sessionId: 'chat-1' } },
      undefined,
      { kind: 'local' }
    )
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('finds the bot of a bare link, or of a thread this computer lacks, on any computer', async () => {
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'home', botId: 'bot_1' })
    await settle()
    deliver({
      kind: 'home',
      botId: 'bot_2',
      conversation: { source: 'slack', externalId: 'T1:C1:1' }
    })
    await settle()

    expect(mocks.openBotLinkHome.mock.calls).toEqual([
      ['bot_1', null],
      ['bot_2', { source: 'slack', externalId: 'T1:C1:1' }]
    ])
  })

  it('redeems an "Open Orca" link at once, with no confirm, then opens Settings › Bots', async () => {
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'connector-link', source: 'linear', token: 'tok' })
    await settle()

    expect(mocks.redeem).toHaveBeenCalledWith('linear', 'tok')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Linear connected.')
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({ pane: 'bots', repoId: null })
    expect(mocks.openSettingsPage).toHaveBeenCalled()
  })

  it('says why a link could not be redeemed, and opens nothing', async () => {
    mocks.redeem.mockResolvedValueOnce({ ok: false, error: 'wrong_account' })
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'connector-link', source: 'github', token: 'tok' })
    await settle()

    expect(mocks.redeem).toHaveBeenCalledWith('github', 'tok')
    expect(mocks.toastError).toHaveBeenCalledWith('github:wrong_account')
    expect(mocks.openSettingsTarget).not.toHaveBeenCalled()
  })

  it('leaves an open setup dialog to carry on from the redeemed link', async () => {
    mocks.setupOpen.mockReturnValue(true)
    const { deliver } = stubPreload(null)
    registerBotDeepLinkIpcBridge([])
    await settle()

    deliver({ kind: 'connector-link', source: 'github', token: 'tok' })
    await settle()

    expect(mocks.redeem).toHaveBeenCalledWith('github', 'tok')
    expect(mocks.openSettingsTarget).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    mocks.setupOpen.mockReturnValue(false)
  })
})

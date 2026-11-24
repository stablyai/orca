// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redeem: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }))
vi.mock('@/lib/connector-connect-state', () => ({ redeemConnectorLink: mocks.redeem }))
vi.mock('@/lib/connector-setup-open', () => ({ isConnectorSetupOpen: () => false }))
vi.mock('@/lib/bot-access-requests', () => ({ watchAccessRequests: () => () => {} }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      workspaceSessionReady: true,
      openSettingsTarget: mocks.openSettingsTarget,
      openSettingsPage: mocks.openSettingsPage
    })
  }
}))

import { registerBotDeepLinkIpcBridge } from './bot-deep-link-ipc-bridge'

/** Opens one `orca://<source>/link` "Open Orca" fallback through the bridge. */
async function openConnectorLink(source: string): Promise<void> {
  const pending = [{ kind: 'connector-link', source, token: 't' }]
  vi.stubGlobal('window', {
    api: {
      ui: {
        consumePendingBotLink: async () => pending.shift() ?? null,
        onBotLinkPending: () => () => {}
      }
    }
  })
  registerBotDeepLinkIpcBridge([])
  await vi.waitFor(() => expect(mocks.redeem).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
  Object.values(mocks).forEach((mock) => mock.mockReset())
})

describe('the "Open Orca" fallback of Sign in with Slack', () => {
  it('says Slack linked and opens the linked accounts', async () => {
    mocks.redeem.mockResolvedValue({ ok: true, value: {} })
    await openConnectorLink('slack')
    expect(mocks.redeem).toHaveBeenCalledWith('slack', 't')
    expect(mocks.success).toHaveBeenCalledWith('Slack linked.')
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({ pane: 'orca-account', repoId: null })
  })

  it("explains Slack's own failure, never GitHub's", async () => {
    mocks.redeem.mockResolvedValue({ ok: false, error: 'wrong_account' })
    await openConnectorLink('slack')
    expect(mocks.error).toHaveBeenCalledWith(
      'This sign-in was started from another Orca account. Sign in with Slack again from this one.'
    )
  })
})

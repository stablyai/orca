// @vitest-environment happy-dom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppHttpLinkOpen from '@/lib/browser/navigation/app-http-link-open'

const mocks = vi.hoisted(() => {
  const realOpenAppHttpLink: { current?: typeof AppHttpLinkOpen.openAppHttpLink } = {}
  return {
    rpc: vi.fn(),
    openUrl: vi.fn(),
    openAppHttpLink: vi.fn(),
    getStatus: vi.fn(),
    // The bot's workspace is on a paired server unless a test says otherwise.
    owner: { kind: 'runtime' },
    realOpenAppHttpLink
  }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBots: () => [{ id: 'bot-1', hostId: 'local', folderWorkspaceId: 'fw-1' }]
}))
vi.mock('@/lib/browser/navigation/app-http-link-open', async (actual) => {
  const real = await actual<typeof AppHttpLinkOpen>()
  // The router itself, for a test that needs where a page really goes.
  mocks.realOpenAppHttpLink.current = real.openAppHttpLink
  return { ...real, openAppHttpLink: mocks.openAppHttpLink }
})
vi.mock(
  '@/components/native-chat/links/actions/native-chat-http-link-source-owner',
  async (actual) => ({
    ...(await actual<Record<string, unknown>>()),
    resolveNativeChatHttpLinkSourceOwner: () =>
      mocks.owner.kind === 'runtime'
        ? { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
        : { kind: mocks.owner.kind }
  })
)
vi.mock('@/lib/browser/workspace/workspace-browser-route-eligibility', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  canOpenWorkspaceBrowserTabOnRuntime: () => mocks.owner.kind === 'runtime'
}))

import {
  botToolSignInFailure,
  botToolSignInOutcome,
  connectBotTool,
  resetBotToolSignInsForTest,
  signInOnHost,
  useBotToolSignIn
} from './bot-tools-client'
import { BotToolFinishSignIn } from './BotToolFinishSignIn'

const PAGE = 'https://app.example.com/authorize?client_id=c&state=s-1'
const RETURN = 'http://127.0.0.1:41234/orca/app-callback'
const waiting = (flowId: string) => ({
  flowId,
  revision: 1,
  // 2100-01-01: never expires during the test.
  expiresAt: 4_102_444_800_000,
  state: 'waiting',
  authorizationUrl: PAGE,
  redirectUri: RETURN
})
const calls = (method: string) =>
  mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)

describe("signing in to a bot's app on its host from another device", () => {
  let capabilities: string[]
  beforeEach(() => {
    capabilities = ['bots.tools.owned-sign-in.v1']
    let flows = 0
    mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
      switch (method) {
        case 'bots.tools.signIn.start':
          flows += 1
          return waiting(`flow-${flows}`)
        case 'bots.tools.signIn.finish':
          return { flowId: 'flow-1', revision: 3, expiresAt: 0, state: 'done' }
        case 'bots.tools.signIn.wait':
          return new Promise(() => {})
        default:
          return {}
      }
    })
    mocks.openUrl.mockReset()
    mocks.openAppHttpLink.mockReset()
    mocks.getStatus.mockReset().mockImplementation(async () => ({ capabilities }))
    Object.assign(window, {
      __ORCA_WEB_CLIENT__: true,
      api: { shell: { openUrl: mocks.openUrl }, runtime: { getStatus: mocks.getStatus } }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    resetBotToolSignInsForTest()
    Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
  })

  it('opens the page locally and accepts only the pasted address for the active sign-in', async () => {
    await connectBotTool({ hostId: 'local', id: 'bot-1' }, 'notion', true)
    expect(calls('bots.tools.signIn.start')).toEqual([
      { botId: 'bot-1', name: 'notion', mode: 'paste' }
    ])
    expect(mocks.openUrl).toHaveBeenCalledWith(PAGE)

    render(<BotToolFinishSignIn bot={{ hostId: 'local', id: 'bot-1' }} name="notion" />)
    const paste = (state: string) => {
      fireEvent.change(screen.getByLabelText('Address'), {
        target: { value: `${RETURN}?code=c-1&state=${state}` }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
    }
    paste('someone-else')
    expect((await screen.findByRole('alert')).textContent).toContain('isn’t from this sign-in')
    expect(calls('bots.tools.signIn.finish')).toEqual([])

    paste('s-1')
    await waitFor(() =>
      expect(botToolSignInOutcome({ hostId: 'local', id: 'bot-1' }, 'notion')).toBe('done')
    )
    expect(calls('bots.tools.signIn.finish')).toEqual([
      { flowId: 'flow-1', query: 'code=c-1&state=s-1' }
    ])
  })

  it('starts nothing on a host whose Orca predates it, and says it needs an update', async () => {
    capabilities = []
    await connectBotTool({ hostId: 'local', id: 'bot-1' }, 'notion', true)
    expect(calls('bots.tools.signIn.start')).toEqual([])
    expect(botToolSignInFailure({ hostId: 'local', id: 'bot-1' }, 'notion')).toBe('needs-update')
  })

  it("opens a routed page in the bot's workspace, and ends the sign-in when it can't", async () => {
    mocks.openAppHttpLink.mockReturnValueOnce('orca-browser')
    await signInOnHost({ hostId: 'local', id: 'bot-1' }, 'notion', 'routed')
    expect(mocks.openAppHttpLink).toHaveBeenCalledWith(PAGE, {
      worktreeId: 'folder:fw-1',
      forceInApp: true
    })
    expect(mocks.openUrl).not.toHaveBeenCalled()

    mocks.openAppHttpLink.mockReturnValueOnce('system-browser')
    expect(await signInOnHost({ hostId: 'local', id: 'bot-1' }, 'linear', 'routed')).toBeNull()
    expect(calls('bots.tools.signIn.cancel')).toEqual([{ flowId: 'flow-2' }])
    expect(calls('bots.tools.signIn.start')).not.toContainEqual(
      expect.objectContaining({ mode: 'paste' })
    )
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })

  it('ends the sign-in when the workspace’s owner is unknown, as no host can route the page', async () => {
    mocks.owner.kind = 'unknown'
    const realOpen = mocks.realOpenAppHttpLink.current
    if (!realOpen) {
      throw new Error('the link router was not loaded')
    }
    mocks.openAppHttpLink.mockImplementationOnce(realOpen)
    try {
      expect(await signInOnHost({ hostId: 'local', id: 'bot-1' }, 'notion', 'routed')).toBeNull()
      expect(calls('bots.tools.signIn.cancel')).toEqual([{ flowId: 'flow-1' }])
      expect(calls('bots.tools.signIn.start')).toHaveLength(1)
      expect(mocks.openUrl).not.toHaveBeenCalled()
    } finally {
      mocks.owner.kind = 'runtime'
    }
  })

  it('ends the host’s sign-in when the last surface showing it closes, not before', async () => {
    vi.useFakeTimers()
    await connectBotTool({ hostId: 'local', id: 'bot-1' }, 'notion', true)
    const row = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion'))
    const dialog = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion'))

    dialog.unmount()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls('bots.tools.signIn.cancel')).toEqual([])

    row.unmount()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls('bots.tools.signIn.cancel')).toEqual([{ flowId: 'flow-1' }])
    expect(botToolSignInOutcome({ hostId: 'local', id: 'bot-1' }, 'notion')).toBeUndefined()
    expect(
      renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion')).result.current
        .active
    ).toBe(false)
  })

  it('cancels a start its surface left before the host answered', async () => {
    vi.useFakeTimers()
    const start = Promise.withResolvers<unknown>()
    const answer = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation((target: unknown, method: string, params: unknown) =>
      method === 'bots.tools.signIn.start' ? start.promise : answer(target, method, params)
    )
    const connecting = connectBotTool({ hostId: 'local', id: 'bot-1' }, 'notion', true)
    const dialog = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion'))
    dialog.unmount()
    await vi.advanceTimersByTimeAsync(10)

    start.resolve(waiting('flow-9'))
    await connecting
    expect(calls('bots.tools.signIn.cancel')).toEqual([{ flowId: 'flow-9' }])
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })
})

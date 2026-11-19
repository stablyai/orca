// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  supports: vi.fn(),
  openUrl: vi.fn(),
  webClient: { current: false }
}))
vi.mock('@/app-shell/chrome/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => mocks.webClient.current
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  connectGoogle,
  finishGoogleSignInWithAddress,
  refreshGoogle,
  useBotGoogleReach
} from './google-connect-client'

const SERVER = { kind: 'environment', environmentId: 'env-1' } as const
const account = { email: 'dana@example.com', status: 'connected', services: [], connectedAt: 1 }
const prompt = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
  redirectUri: 'http://127.0.0.1:50123/google/callback',
  expiresAt: 0,
  browserOpened: false
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.supports.mockReset()
  mocks.openUrl.mockReset()
  mocks.webClient.current = false
  Object.assign(window, {
    api: {
      shell: { openUrl: mocks.openUrl }
    }
  })
})

describe("a paired server's Google", () => {
  it('says to update a server without Google, without calling it', async () => {
    mocks.supports.mockResolvedValue(false)
    expect(await refreshGoogle(SERVER)).toEqual({ status: 'update-server' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("on the web client, opens Google's page here and finishes with the address pasted back", async () => {
    mocks.webClient.current = true
    let signedIn: () => void = () => {}
    const pasted = new Promise<void>((resolve) => {
      signedIn = resolve
    })
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'google.signIn.start') {
        return { flowId: 'f', revision: 1, phase: 'waiting', prompt }
      }
      if (method === 'google.finishSignIn') {
        signedIn()
        return { flowId: 'f', revision: 2, phase: 'verifying' }
      }
      if (method === 'google.signIn.wait') {
        await pasted
        return { flowId: 'f', revision: 3, phase: 'signedIn', account }
      }
      return { client: null, accounts: [], bots: [] }
    })
    const onPrompt = vi.fn()
    const connecting = connectGoogle(SERVER, { services: ['gmail'] }, onPrompt)
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledWith(prompt, 'paste'))
    expect(mocks.openUrl).toHaveBeenCalledWith(prompt.authorizeUrl)

    await finishGoogleSignInWithAddress(' http://127.0.0.1:50123/google/callback?state=s&code=c ')
    expect(mocks.rpc).toHaveBeenCalledWith(SERVER, 'google.finishSignIn', {
      flowId: 'f',
      address: 'http://127.0.0.1:50123/google/callback?state=s&code=c'
    })
    await expect(connecting).resolves.toEqual(account)
  })

  it("on a desktop, opens nothing when the server's browser can't be reached", async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'google.signIn.start'
        ? { flowId: 'f', revision: 1, phase: 'waiting', prompt }
        : { client: null, accounts: [], bots: [] }
    )
    const onPrompt = vi.fn()
    await expect(connectGoogle(SERVER, { services: ['gmail'] }, onPrompt)).rejects.toThrow(
      /Can’t reach .* to open this page in its browser/
    )
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(onPrompt).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledWith(SERVER, 'google.signIn.cancel', { flowId: 'f' })
  })
})

describe("this computer's Google", () => {
  it('lets the host open the browser', async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'google.signIn.start'
        ? { flowId: 'f', revision: 1, phase: 'waiting', prompt: { ...prompt, browserOpened: true } }
        : method === 'google.signIn.wait'
          ? { flowId: 'f', revision: 2, phase: 'signedIn', account }
          : { client: null, accounts: [], bots: [] }
    )
    await connectGoogle({ kind: 'local' }, { services: ['gmail', 'files'] }, () => {})
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })
})

describe('what Google reaches through a bot', () => {
  // A host of its own per case: the client keeps each host's last status.
  const reachOn = (environmentId: string) =>
    renderHook(() => useBotGoogleReach({ google: true, hostId: `runtime:${environmentId}` }))
  const status = (services: { service: 'gmail'; state: 'ready' }[]) => ({
    client: null,
    accounts: [{ ...account, services }],
    bots: []
  })
  const noService = status([])
  const gmailReady = status([{ service: 'gmail', state: 'ready' }])
  function answerLater(): (value: unknown) => void {
    let answer: (value: unknown) => void = () => {}
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    return (value) => answer(value)
  }

  beforeEach(() => {
    mocks.supports.mockResolvedValue(true)
  })

  it('does not trust an older "no ready service" until the read it starts answers', async () => {
    mocks.rpc.mockResolvedValueOnce(noService)
    await refreshGoogle({ kind: 'environment', environmentId: 'env-cached' })
    const answer = answerLater()
    // Every value the confirm renders with, the first one before its own read has started.
    const shown: ReturnType<typeof useBotGoogleReach>[] = []
    const { result } = renderHook(() => {
      const reach = useBotGoogleReach({ google: true, hostId: 'runtime:env-cached' })
      shown.push(reach)
      return reach
    })
    expect(shown[0]).toEqual({ areas: [], unknown: true })
    expect(result.current).toEqual({ areas: [], unknown: true })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))

    await act(async () => answer(noService))
    expect(result.current).toEqual({ areas: [], unknown: false })
  })

  it('does not trust an older "no Google on this server" once the server may have it', async () => {
    mocks.supports.mockResolvedValueOnce(false)
    await refreshGoogle({ kind: 'environment', environmentId: 'env-updated' })
    const answer = answerLater()
    const { result } = reachOn('env-updated')
    expect(result.current).toEqual({ areas: [], unknown: true })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))

    await act(async () => answer(gmailReady))
    expect(result.current).toEqual({ areas: ['email'], unknown: false })
  })

  it('stops trusting "no ready service" while a newer read is out, then follows its answers', async () => {
    mocks.rpc.mockResolvedValueOnce(noService)
    const { result } = reachOn('env-reread')
    await waitFor(() => expect(result.current).toEqual({ areas: [], unknown: false }))
    const target = { kind: 'environment', environmentId: 'env-reread' } as const

    const answer = answerLater()
    let reread: Promise<unknown> = Promise.resolve()
    act(() => {
      reread = refreshGoogle(target)
    })
    expect(result.current).toEqual({ areas: [], unknown: true })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
    await act(async () => {
      answer(gmailReady)
      await reread
    })
    expect(result.current).toEqual({ areas: ['email'], unknown: false })

    mocks.rpc.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await refreshGoogle(target)
    })
    expect(result.current).toEqual({ areas: [], unknown: true })
  })

  it('stops trusting "no Google on this server" while a newer read is out', async () => {
    mocks.supports.mockResolvedValueOnce(false)
    const { result } = reachOn('env-reread-server')
    await waitFor(() => expect(result.current).toEqual({ areas: [], unknown: false }))

    const answer = answerLater()
    let reread: Promise<unknown> = Promise.resolve()
    act(() => {
      reread = refreshGoogle({ kind: 'environment', environmentId: 'env-reread-server' })
    })
    expect(result.current).toEqual({ areas: [], unknown: true })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
    await act(async () => {
      answer(noService)
      await reread
    })
    expect(result.current).toEqual({ areas: [], unknown: false })
  })

  it('keeps the newest read when an older one answers after it', async () => {
    const answerOlder = answerLater()
    const { result } = reachOn('env-race')
    expect(result.current).toEqual({ areas: [], unknown: true })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
    const answerNewer = answerLater()
    const newer = refreshGoogle({ kind: 'environment', environmentId: 'env-race' })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))

    await act(async () => {
      answerNewer(gmailReady)
      await newer
    })
    expect(result.current).toEqual({ areas: ['email'], unknown: false })
    await act(async () => answerOlder(noService))
    expect(result.current).toEqual({ areas: ['email'], unknown: false })
  })
})

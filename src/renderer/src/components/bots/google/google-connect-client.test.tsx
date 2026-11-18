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

import {
  connectGoogle,
  finishGoogleSignInWithAddress,
  refreshGoogle
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

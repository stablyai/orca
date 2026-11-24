import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { openOwnedHttpLink, type HttpLinkAdmission } from './http-link-routing'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

const ENV = 'env-1'
const SERVER = { kind: 'runtime', runtimeEnvironmentId: ENV } as const
const openUrl = vi.fn<(url: string) => Promise<void>>()
const initialState = useAppStore.getInitialState()
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function forwardPort(remotePort: number, localPort: number): void {
  useAppStore.setState({
    portForwardsByConnection: {
      [ENV]: [{ id: 'f1', connectionId: ENV, localPort, remoteHost: 'localhost', remotePort }]
    }
  })
}

// The chooser's System Browser row, as a Remember would consume its admission.
async function openInSystemBrowser(
  url: string,
  sourceOwner: Parameters<typeof openOwnedHttpLink>[1]['sourceOwner']
): Promise<HttpLinkAdmission[]> {
  const outcomes: HttpLinkAdmission[] = []
  openOwnedHttpLink(url, {
    sourceOwner,
    worktreeId: null,
    forceSystemBrowser: true,
    onAdmission: (outcome) => {
      outcomes.push(outcome)
    }
  })
  for (let i = 0; i < 5; i += 1) {
    await flush()
  }
  return outcomes
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  openUrl.mockReset()
  openUrl.mockResolvedValue(undefined)
  toastError.mockReset()
  // No live forward API: a link with no existing forward can only be refused, never hang on a call.
  const current = globalThis.window ?? {}
  Object.assign(globalThis, {
    window: Object.assign(current, {
      api: { ...current.api, shell: { openUrl }, runtimeEnvironments: {} }
    })
  })
})
afterEach(() => useAppStore.setState(initialState, true))

describe('a System Browser open of a paired server localhost link', () => {
  it('admits once the shell accepts the forwarded address, never the server one', async () => {
    forwardPort(3000, 41000)
    expect(await openInSystemBrowser('http://localhost:3000/app', SERVER)).toEqual(['admitted'])
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(['http://localhost:41000/app'])
  })

  it('is refused when no forward can be made, and nothing reaches the shell', async () => {
    expect(await openInSystemBrowser('http://localhost:3000/app', SERVER)).toEqual(['refused'])
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('fails when the shell rejects the forwarded address', async () => {
    forwardPort(3000, 41000)
    openUrl.mockRejectedValue(new Error('no handler'))
    expect(await openInSystemBrowser('http://localhost:3000/app', SERVER)).toEqual(['failed'])
  })

  it('admits a link from this computer straight from the shell (control)', async () => {
    expect(await openInSystemBrowser('http://localhost:3000/app', { kind: 'local' })).toEqual([
      'admitted'
    ])
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(['http://localhost:3000/app'])
  })
})

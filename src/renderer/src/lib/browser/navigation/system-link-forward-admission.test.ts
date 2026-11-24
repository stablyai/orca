import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { openOwnedHttpLink, type HttpLinkAdmission } from './http-link-routing'

const toastError = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
// The server answers the port-forward capability probe; the forward itself goes through window.api.
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: () => Promise.resolve(true)
}))

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
  sourceOwner: Parameters<typeof openOwnedHttpLink>[1]['sourceOwner'],
  isCurrentRequest?: () => boolean
): Promise<HttpLinkAdmission[]> {
  const outcomes: HttpLinkAdmission[] = []
  openOwnedHttpLink(url, {
    sourceOwner,
    worktreeId: null,
    forceSystemBrowser: true,
    ...(isCurrentRequest ? { linkContext: { linkIntent: null, isCurrentRequest } } : {}),
    onAdmission: (outcome) => {
      outcomes.push(outcome)
    }
  })
  await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(0))
  // Settles once: a later answer for the same open must not add a second outcome.
  await flush()
  return outcomes
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  openUrl.mockReset()
  openUrl.mockResolvedValue(undefined)
  toastError.mockReset()
  toastSuccess.mockReset()
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

  it('opens nothing when a newer link open supersedes it while the forward is prepared', async () => {
    forwardPort(3000, 41000)
    let checks = 0
    // Current at the click, stale by the time the forwarded address is ready.
    const isCurrentRequest = (): boolean => (checks += 1) === 1
    expect(
      await openInSystemBrowser('http://localhost:3000/app', SERVER, isCurrentRequest)
    ).toEqual(['superseded'])
    expect(openUrl).not.toHaveBeenCalled()
  })

  // A forward this click creates: the toast says the page opened only when it did.
  function serverCreatesForward(): void {
    const ensure = vi.fn(() =>
      Promise.resolve({
        created: true,
        entry: {
          id: 'f2',
          connectionId: ENV,
          localPort: 41001,
          remoteHost: 'localhost',
          remotePort: 3001
        }
      })
    )
    Object.assign(window.api, { runtimeEnvironments: { portForwards: { ensure } } })
  }

  it('says a newly forwarded page opened once the shell takes it', async () => {
    serverCreatesForward()
    expect(await openInSystemBrowser('http://localhost:3001/', SERVER)).toEqual(['admitted'])
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(['http://localhost:41001/'])
    expect(toastSuccess.mock.calls[0]?.[1]).toHaveProperty('description')
  })

  it('does not claim an open when a newer link superseded the new forward', async () => {
    serverCreatesForward()
    let checks = 0
    const isCurrentRequest = (): boolean => (checks += 1) === 1
    expect(await openInSystemBrowser('http://localhost:3001/', SERVER, isCurrentRequest)).toEqual([
      'superseded'
    ])
    expect(openUrl).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('admits a link from this computer straight from the shell (control)', async () => {
    expect(await openInSystemBrowser('http://localhost:3000/app', { kind: 'local' })).toEqual([
      'admitted'
    ])
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual(['http://localhost:3000/app'])
  })
})

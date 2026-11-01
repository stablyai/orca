import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RemoteBrowserPageHandle } from '../store/slices/browser'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  type RuntimeEnvironmentStatus,
  type RuntimeStatusSlice
} from '../store/slices/runtime-status'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import {
  ensureBrowserClientHostOnRuntimeContact,
  ensureBrowserClientHostsForRestoredPages,
  resetRestoredBrowserClientHostAttachForTests
} from './restored-client-hosted-browser-host-attach'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

const prepareBrowserClientHostPlacement = vi.fn(
  async (_args: { selector: string; preference: string }) => ({ kind: 'server' as const })
)

function stubApi(): void {
  stubRuntimeEnvironmentBridge({
    getStatus: vi.fn(),
    list: vi.fn(),
    prepareBrowserClientHostPlacement
  })
}

const CLIENT_PLACEMENT = {
  kind: 'client',
  browserHostClientId: 'browser-host-1',
  browserHostGeneration: 1,
  pageHostGeneration: 1
} as const

type HandleSeed = Omit<RemoteBrowserPageHandle, 'remotePageId'>

function stateWith(seeds: Record<string, HandleSeed>): {
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
} {
  return {
    remoteBrowserPageHandlesByPageId: Object.fromEntries(
      Object.entries(seeds).map(([pageId, seed]) => [
        pageId,
        { remotePageId: `remote-${pageId}`, ...seed }
      ])
    )
  }
}

function preparedEnvironmentIds(): string[] {
  return prepareBrowserClientHostPlacement.mock.calls.map((call) => call[0].selector)
}

describe('ensureBrowserClientHostOnRuntimeContact', () => {
  beforeEach(() => {
    resetRestoredBrowserClientHostAttachForTests()
    prepareBrowserClientHostPlacement.mockClear()
    prepareBrowserClientHostPlacement.mockResolvedValue({ kind: 'server' as const })
    stubApi()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Live desktop guests survive; replaceAuthority hands replacement runtime an adoptable inventory.
  it('prepares the host for an environment with a live client-placed page', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({ 'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT } }),
      'env-a'
    )

    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledTimes(1)
    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-a',
      preference: 'auto'
    })
  })

  // Why: a staged page has no host-minted placement yet, but this desktop is already its host.
  it('prepares the host for a staged client-hosted page with no placement yet', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({ 'page-1': { environmentId: 'env-a', staged: true, stagedClientHosted: true } }),
      'env-a'
    )

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
  })

  // Why: a session-restored row that adoption has not spent yet is client-hosted just as surely.
  it('prepares the host for a restored client-hosted page with no placement yet', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({
        'page-1': { environmentId: 'env-a', restoredFromSession: true, restoredClientHosted: true }
      }),
      'env-a'
    )

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
  })

  it('prepares no host when the environment has no handles at all', async () => {
    await ensureBrowserClientHostOnRuntimeContact(stateWith({}), 'env-a')

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  // Server-only pages need no new desktop hosting claim on restart.
  it('prepares no host when the environment only has server-hosted pages', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({ 'page-1': { environmentId: 'env-a', placement: { kind: 'server' } } }),
      'env-a'
    )

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  // Why: one runtime restarting must not start a host on every other environment this client knows.
  it('prepares no host when the only client-hosted page belongs to another environment', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({ 'page-1': { environmentId: 'env-b', placement: CLIENT_PLACEMENT } }),
      'env-a'
    )

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  it('prepares only the restarted environment when several have client-hosted pages', async () => {
    await ensureBrowserClientHostOnRuntimeContact(
      stateWith({
        'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT },
        'page-2': { environmentId: 'env-b', placement: CLIENT_PLACEMENT }
      }),
      'env-a'
    )

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
  })

  // Status-update callers must retain unrelated updates if preparation throws.
  it('swallows a failed preparation instead of rejecting into the status update', async () => {
    prepareBrowserClientHostPlacement.mockRejectedValue(new Error('runtime_unreachable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      ensureBrowserClientHostOnRuntimeContact(
        stateWith({ 'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT } }),
        'env-a'
      )
    ).resolves.toBeUndefined()

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Why: a restart can be observed before the browser slice has published any handle map.
  it('tolerates a state with no handle map at all', async () => {
    await expect(ensureBrowserClientHostOnRuntimeContact({}, 'env-a')).resolves.toBeUndefined()

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  // Preparation aimed at dead runtime can hang until timeout; restart must bypass it or lose the authority-change signal.
  it('re-prepares after an in-flight preparation aimed at the dead runtime settles', async () => {
    const state = stateWith({ 'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT } })
    let releaseFirst = (): void => {}
    prepareBrowserClientHostPlacement.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ kind: 'server' as const })
        })
    )

    const restored = ensureBrowserClientHostsForRestoredPages(
      stateWith({ 'page-1': { environmentId: 'env-a', restoredClientHosted: true } })
    )
    const restarted = ensureBrowserClientHostOnRuntimeContact(state, 'env-a')
    releaseFirst()
    await Promise.all([restored, restarted])

    expect(preparedEnvironmentIds()).toEqual(['env-a', 'env-a'])
  })

  // Why: a preparation in flight when contact returns began while the host was unreachable.
  it('re-prepares when contact returns during a preparation that then fails', async () => {
    const state = stateWith({ 'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT } })
    let releaseFirst = (): void => {}
    prepareBrowserClientHostPlacement.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ kind: 'server' as const })
        })
    )

    const restored = ensureBrowserClientHostsForRestoredPages(
      stateWith({ 'page-1': { environmentId: 'env-a', restoredClientHosted: true } })
    )
    const regained = ensureBrowserClientHostOnRuntimeContact(state, 'env-a')
    releaseFirst()
    await Promise.all([restored, regained])

    expect(preparedEnvironmentIds()).toEqual(['env-a', 'env-a'])
  })
})

function statusFor(runtimeId: string, checkedAt = 1): RuntimeEnvironmentStatus {
  const response = createCompatibleRuntimeStatusResponse(runtimeId)
  return { status: response.ok ? response.result : null, checkedAt }
}

/** A status slice whose state also carries the client-hosted handle the restart attach reads. */
function storeWithClientHostedPage() {
  return create<RuntimeStatusSlice & { remoteBrowserPageHandlesByPageId: unknown }>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>)),
    ...stateWith({ 'page-1': { environmentId: 'env-a', placement: CLIENT_PLACEMENT } })
  }))
}

describe('setRuntimeEnvironmentStatus runtime-contact detection', () => {
  beforeEach(() => {
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetRestoredBrowserClientHostAttachForTests()
    prepareBrowserClientHostPlacement.mockClear()
    prepareBrowserClientHostPlacement.mockResolvedValue({ kind: 'server' as const })
    stubApi()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Without mid-session ID-change observation, rows recover only by accidental new-tab/relaunch attach.
  it('re-attaches when a known environment comes back under a new runtime id', async () => {
    const store = storeWithClientHostedPage()

    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1'))
    prepareBrowserClientHostPlacement.mockClear()
    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-2'))
    await Promise.resolve()

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
  })

  // Why: without the known-previous guard the restart path would fire on every ordinary startup.
  it('does not re-attach on a first connect', async () => {
    const store = storeWithClientHostedPage()

    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1'))
    await Promise.resolve()

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  // Outages beyond lease grace destroy host/guests; this recovery must restart hosting or tabs remain unavailable.
  it('re-attaches when the same runtime answers again after contact was lost', async () => {
    const store = storeWithClientHostedPage()

    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1'))
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })
    await Promise.resolve()
    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1', 3))
    await Promise.resolve()

    expect(preparedEnvironmentIds()).toEqual(['env-a'])
  })

  it('does not re-attach when a re-probe reports the same runtime id', async () => {
    const store = storeWithClientHostedPage()

    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1'))
    prepareBrowserClientHostPlacement.mockClear()
    store.getState().setRuntimeEnvironmentStatus('env-a', statusFor('runtime-1', 2))
    await Promise.resolve()

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })
})

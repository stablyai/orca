import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zustand'
import type { RemoteBrowserPageHandle } from '../store/slices/browser'
import '../store/slices/runtime-status'
import './runtime-compatibility-test-fixture'
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
})

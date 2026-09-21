import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import { resetRestoredBrowserClientHostAttachForTests } from '@/runtime/restored-client-hosted-browser-host-attach'
import { replayClientHostedBrowserCloseIntents } from '@/runtime/client-hosted-browser-close-intent-replay'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  type RuntimeStatusSlice
} from './runtime-status'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('@/runtime/client-hosted-browser-close-intent-replay', () => ({
  replayClientHostedBrowserCloseIntents: vi.fn(async () => {})
}))

const prepareBrowserClientHostPlacement = vi.fn(async (_args: { selector: string }) => ({
  kind: 'server' as const
}))

function stubApi(getStatus: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        getStatus,
        list: vi.fn(),
        prepareBrowserClientHostPlacement
      }
    }
  })
}

/** A status slice whose state also carries the browser handles the attach step reads. */
function storeWithRestoredHandles(clientHosted: boolean) {
  return create<RuntimeStatusSlice & { remoteBrowserPageHandlesByPageId: unknown }>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>)),
    remoteBrowserPageHandlesByPageId: {
      'page-1': {
        environmentId: 'env-a',
        remotePageId: 'page-1',
        restoredFromSession: true,
        ...(clientHosted ? { restoredClientHosted: true } : {})
      }
    }
  }))
}

describe('restored client-hosted browser host attach on reachability', () => {
  beforeEach(() => {
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetRestoredBrowserClientHostAttachForTests()
    prepareBrowserClientHostPlacement.mockClear()
    vi.mocked(replayClientHostedBrowserCloseIntents).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Why: after a relaunch this desktop hosts nothing, so a page it used to host only comes back
  // once it attaches again. Hydration alone can ask before the environment is reachable.
  it('starts the browser client host for restored client-hosted pages once reachable', async () => {
    stubApi(vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a')))

    await storeWithRestoredHandles(true).getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-a',
      preference: 'auto'
    })
  })

  it('runs both recovery follow-ups after a successful refresh', async () => {
    stubApi(vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a')))

    await storeWithRestoredHandles(true).getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-a',
      preference: 'auto'
    })
    expect(replayClientHostedBrowserCloseIntents).toHaveBeenCalledWith('env-a', expect.anything())
  })

  it('runs no recovery follow-ups when the environment is unreachable', async () => {
    stubApi(vi.fn().mockRejectedValue(new Error('unreachable')))
    await storeWithRestoredHandles(true).getState().refreshRuntimeEnvironmentStatus('env-a')
    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
    expect(replayClientHostedBrowserCloseIntents).not.toHaveBeenCalled()
  })

  it('starts no browser client host for restored pages the server hosts', async () => {
    stubApi(vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a')))

    await storeWithRestoredHandles(false).getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })
})

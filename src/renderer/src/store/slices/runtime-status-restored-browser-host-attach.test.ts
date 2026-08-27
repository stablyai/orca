import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import { resetRestoredBrowserClientHostAttachForTests } from '@/runtime/restored-client-hosted-browser-host-attach'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  type RuntimeStatusSlice
} from './runtime-status'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
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

  it('starts no browser client host when the environment is unreachable', async () => {
    stubApi(vi.fn().mockRejectedValue(new Error('unreachable')))

    await storeWithRestoredHandles(true).getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  it('starts no browser client host for restored pages the server hosts', async () => {
    stubApi(vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a')))

    await storeWithRestoredHandles(false).getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })
})

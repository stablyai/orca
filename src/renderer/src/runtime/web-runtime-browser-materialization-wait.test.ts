import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    state: {
      browserPagesByWorkspace: {},
      browserTabsByWorktree: {},
      remoteBrowserPageHandlesByPageId: {},
      unifiedTabsByWorktree: {}
    },
    emit: () => listeners.forEach((listener) => listener()),
    listeners
  }
})

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => store.state,
    subscribe: (listener: () => void) => {
      const call = (): void => listener()
      store.listeners.add(call)
      return () => store.listeners.delete(call)
    }
  }
}))

import { waitForWebRuntimeBrowserPageMaterialization } from './web-runtime-browser-materialization-wait'

describe('waitForWebRuntimeBrowserPageMaterialization', () => {
  afterEach(() => {
    vi.useRealTimers()
    store.listeners.clear()
  })

  it('ends when the frames take the page over mid-wait, before any handle (L284)', async () => {
    vi.useFakeTimers()
    let handedOver = false
    const waited = waitForWebRuntimeBrowserPageMaterialization({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remotePageId: 'page-1',
      handedToFrames: () => handedOver
    })
    handedOver = true
    store.emit()
    await expect(waited).resolves.toBe(true)
  })

  it('times out when nothing draws the page', async () => {
    vi.useFakeTimers()
    const waited = waitForWebRuntimeBrowserPageMaterialization({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      remotePageId: 'page-1',
      handedToFrames: () => false
    })
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(waited).resolves.toBe(false)
  })
})

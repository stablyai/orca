// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  invalidateLocalImageSrcCacheForTests,
  resetLocalImageSrcStateForTests
} from '@/components/editor/useLocalImageSrc'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function runtimeContext(worktreeId: string): RuntimeFileOperationArgs {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId,
    worktreePath: `/repo/${worktreeId}`,
    expectedExecutionHostId: 'local'
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  let urlSequence = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:owner-${++urlSequence}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  window.api = {
    fs: {
      readFile: vi.fn().mockResolvedValue({
        content: 'AA==',
        isBinary: true,
        mimeType: 'image/png'
      })
    }
  } as unknown as Window['api']
})

afterEach(() => {
  resetLocalImageSrcStateForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NativeChatImageAttachments', () => {
  it('pools visibility observation across image refs', async () => {
    class FakeIntersectionObserver {
      static instances: FakeIntersectionObserver[] = []
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()

      constructor(_callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.instances.push(this)
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks: [
            { type: 'image-ref' as const, path: '/repo/one.png' },
            { type: 'image-ref' as const, path: '/repo/two.png' },
            { type: 'image-ref' as const, path: '/repo/three.png' }
          ],
          runtimeContext: runtimeContext('wt-1')
        })
      )
      await flushPromises()
    })

    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances[0]?.observe).toHaveBeenCalledTimes(3)

    root.unmount()
    expect(FakeIntersectionObserver.instances[0]?.unobserve).toHaveBeenCalledTimes(3)
    expect(FakeIntersectionObserver.instances[0]?.disconnect).toHaveBeenCalledOnce()
  })

  it('preserves same-image errors but retries when the runtime owner changes', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const blocks = [{ type: 'image-ref' as const, path: '/repo/image.png' }]
    const ownerOne = runtimeContext('wt-1')

    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks,
          runtimeContext: ownerOne
        })
      )
      await flushPromises()
    })
    const firstOwnerSrc = container.querySelector('img')?.getAttribute('src')
    expect(firstOwnerSrc).toBe('blob:owner-1')

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks,
          runtimeContext: ownerOne
        })
      )
      await flushPromises()
    })
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks,
          runtimeContext: runtimeContext('wt-2')
        })
      )
      await flushPromises()
    })
    expect(container.querySelector('img')?.getAttribute('src')).not.toBe(firstOwnerSrc)
    expect(window.api.fs.readFile).toHaveBeenCalledTimes(2)

    root.unmount()
  })

  it('retries a failed thumbnail after the image cache refreshes', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const props = {
      blocks: [{ type: 'image-ref' as const, path: '/repo/image.png' }],
      runtimeContext: runtimeContext('wt-1')
    }

    await act(async () => {
      root.render(createElement(NativeChatImageAttachments, props))
      await flushPromises()
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:owner-1')

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('img')).toBeNull()

    await act(async () => {
      invalidateLocalImageSrcCacheForTests()
      await flushPromises()
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:owner-2')
    root.unmount()
  })

  it('keeps the observed element stable while a preview is materialized', async () => {
    let callback: IntersectionObserverCallback | undefined
    class FakeIntersectionObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()

      constructor(nextCallback: IntersectionObserverCallback) {
        callback = nextCallback
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks: [{ type: 'image-ref' as const, path: '/repo/image.png' }],
          runtimeContext: runtimeContext('wt-1')
        })
      )
      await flushPromises()
    })

    const observedElement = container.firstElementChild
    expect(observedElement).not.toBeNull()
    if (!observedElement || !callback) {
      throw new Error('image preview did not register visibility observation')
    }
    const notifyVisibility = callback
    await act(async () => {
      notifyVisibility(
        [{ target: observedElement, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await flushPromises()
    })

    expect(container.firstElementChild).toBe(observedElement)
    root.unmount()
  })
})

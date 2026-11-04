// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import {
  invalidateLocalImageSrcCacheForTests,
  loadLocalImageSrc,
  resetLocalImageSrcStateForTests
} from '@/components/editor/useLocalImageSrc'
import { chatImageAccess } from '@/lib/local-file-access'
import { useAppStore } from '@/store'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import {
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace
} from './native-chat-workspace-test-fixtures'

// Chat images carry their runtime owner without resolving an editor connection.
const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getConnectionIdForFile: vi.fn(() => {
    throw new Error('Chat image fixtures must not resolve editor file connections')
  })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function runtimeContext(worktreeId: string): RuntimeFileOperationArgs {
  return {
    target: { kind: 'local' as const },
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
  mocks.callRuntimeRpc.mockReset().mockResolvedValue({
    content: 'AA==',
    isBinary: true,
    mimeType: 'image/png'
  })
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
  try {
    expect(mocks.getConnectionIdForFile).not.toHaveBeenCalled()
  } finally {
    mocks.getConnectionIdForFile.mockClear()
    vi.restoreAllMocks()
  }
})

describe('NativeChatImageAttachments', () => {
  it('reads on the selected folder owner and stops reading when that chat disappears', async () => {
    const original = useAppStore.getState()
    const fixture = nativeChatFanoutFixture(1, 1, 0)
    const workspaceId = nativeChatFanoutWorkspace(0)
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      ...fixture,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      runtimeEnvironmentCatalogHydrated: true
    })
    function OwnedAttachments() {
      const context = useNativeChatImageRuntimeContext('chat-0')
      return createElement(NativeChatImageAttachments, {
        blocks: [{ type: 'image-ref', path: '/repo/0/image.png' }],
        runtimeContext: context
      })
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(OwnedAttachments))
        await flushPromises()
      })
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:owner-1')
      expect(window.api.fs.readFile).toHaveBeenCalledExactlyOnceWith({
        filePath: '/repo/0/image.png',
        connectionId: undefined,
        access: { kind: 'chat-image' }
      })
      expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()

      await act(async () => {
        useAppStore.setState({
          folderWorkspaces: fixture.folderWorkspaces.map((folder) => ({
            ...folder,
            executionHostId: 'runtime:attachment-owner' as const
          }))
        })
        await flushPromises()
      })
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:owner-2')
      expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'environment', environmentId: 'attachment-owner' },
        'files.readPreview',
        { worktree: `id:${workspaceId}`, relativePath: 'image.png' },
        expect.objectContaining({ timeoutMs: 15_000 })
      )
      expect(window.api.fs.readFile).toHaveBeenCalledTimes(1)

      await act(async () => {
        useAppStore.setState({ unifiedTabsByWorktree: {} })
        await flushPromises()
      })
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('button')).toBeNull()
      expect(container.textContent).toContain('image.png')
      expect(window.api.fs.readFile).toHaveBeenCalledTimes(1)
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      useAppStore.setState(original, true)
    }
  })

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

  it('offers the full-size file of a sent image to the chat copy menu', async () => {
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

    expect(container.querySelector('button')?.getAttribute('data-native-chat-copy-image-src')).toBe(
      'blob:owner-1'
    )

    root.unmount()
  })

  it.each([
    'data:image/png;base64,AA==',
    'blob:sent-original',
    'http://example.test/original.png',
    'https://example.test/original.svg'
  ])(
    'offers the original displayed source %s in the thumbnail and full-size preview',
    async (src) => {
      const container = document.body.appendChild(document.createElement('div'))
      const root = createRoot(container)
      try {
        await act(async () => {
          root.render(
            createElement(NativeChatImageAttachments, {
              blocks: [{ type: 'image-ref', url: src, alt: 'Sent image' }],
              runtimeContext: runtimeContext('wt-1')
            })
          )
          await flushPromises()
        })
        const thumbnail = within(container).getByRole('button', { name: 'View image: Sent image' })
        expect(thumbnail.getAttribute('data-native-chat-copy-image-src')).toBe(src)
        fireEvent.click(thumbnail)
        const preview = screen.getByRole('dialog', { name: 'Sent image' })
        expect(
          within(preview)
            .getByTestId('pan-zoom-image-canvas')
            .closest('[data-native-chat-copy-image-src]')
            ?.getAttribute('data-native-chat-copy-image-src')
        ).toBe(src)
        expect(window.api.fs.readFile).not.toHaveBeenCalled()
        fireEvent.click(within(preview).getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('dialog')).toBeNull()
      } finally {
        await act(async () => root.unmount())
        container.remove()
      }
    }
  )

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

  it('keeps the shown image when an equal runtime context is rebuilt', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const blocks = [{ type: 'image-ref' as const, path: '/repo/image.png' }]

    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks,
          runtimeContext: runtimeContext('wt-1')
        })
      )
      await flushPromises()
    })
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:owner-1')

    for (let update = 0; update < 3; update += 1) {
      await act(async () => {
        root.render(
          createElement(NativeChatImageAttachments, {
            blocks,
            runtimeContext: runtimeContext('wt-1')
          })
        )
        await flushPromises()
      })
    }

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(window.api.fs.readFile).toHaveBeenCalledOnce()
    expect(container.querySelector('img')).toBe(img)
    expect(img?.getAttribute('src')).toBe('blob:owner-1')

    root.unmount()
  })

  it('keeps an off-screen image cached when an equal runtime context is rebuilt', async () => {
    class FakeIntersectionObserver {
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()
      readonly disconnect = vi.fn()
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    const container = document.createElement('div')
    const root = createRoot(container)
    const blocks = [{ type: 'image-ref' as const, path: '/repo/image.png' }]
    const renderWith = (context: RuntimeFileOperationArgs): void =>
      root.render(createElement(NativeChatImageAttachments, { blocks, runtimeContext: context }))
    const loadSameEntry = (): Promise<string | null> =>
      loadLocalImageSrc(
        '/repo/image.png',
        '/repo/image.png',
        undefined,
        runtimeContext('wt-1'),
        chatImageAccess()
      )

    try {
      await act(async () => {
        renderWith(runtimeContext('wt-1'))
        await flushPromises()
      })
      // Off-screen nothing pins the entry, so only the release effect's deps decide whether it survives.
      await expect(loadSameEntry()).resolves.toBe('blob:owner-1')

      for (let update = 0; update < 3; update += 1) {
        await act(async () => {
          renderWith(runtimeContext('wt-1'))
          await flushPromises()
        })
      }

      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
      await expect(loadSameEntry()).resolves.toBe('blob:owner-1')
      expect(window.api.fs.readFile).toHaveBeenCalledOnce()
    } finally {
      // The visibility observer is module-wide; a leaked one breaks later tests.
      root.unmount()
    }
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

  it.each([
    ['a pasted screenshot in the temp folder', '/tmp/orca-paste-1.png'],
    ['an agent image outside the project', '/Users/me/.codex/generated/plot.png']
  ])('reads %s as a chat image, whoever sent it', async (_label, path) => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(NativeChatImageAttachments, {
          blocks: [{ type: 'image-ref' as const, path }],
          runtimeContext: runtimeContext('wt-1')
        })
      )
      await flushPromises()
    })

    expect(vi.mocked(window.api.fs.readFile).mock.calls[0]?.[0]).toMatchObject({
      filePath: path,
      access: { kind: 'chat-image' }
    })
    root.unmount()
  })
})

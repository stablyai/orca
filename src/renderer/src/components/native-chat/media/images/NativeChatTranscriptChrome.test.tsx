// @vitest-environment happy-dom

import { act, createElement } from 'react'

import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetLocalImageCacheState as resetLocalImageSrcStateForTests } from '@/components/editor/document-images/local-image-src-cache'
import { useAppStore } from '@/store'
import { NativeChatImageAttachments } from './NativeChatImageAttachments'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import {
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace
} from '../../surfaces/integration/native-chat-workspace-test-fixtures'

// Chat images carry their runtime owner without resolving an editor connection.
const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getConnectionIdForFile: vi.fn(() => {
    throw new Error('Chat image fixtures must not resolve editor file connections')
  })
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
})

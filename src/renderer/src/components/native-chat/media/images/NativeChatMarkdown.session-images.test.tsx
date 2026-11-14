import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as TerminalFileOpenRouting from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/components/editor/document-images/useLocalImageSrc'
import { resetLocalImageCacheState as resetLocalImageSrcStateForTests } from '@/components/editor/document-images/local-image-src-cache'
import { useAppStore } from '@/store'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import {
  repoFixture,
  worktreeFixture
} from '../../surfaces/integration/native-chat-workspace-test-fixtures'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  readRuntimeFilePreview: vi.fn(),
  openDetectedFilePath: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/runtime/files/reads/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))
vi.mock(
  '@/components/terminal-pane/links/files/terminal-file-open-routing',
  async (importOriginal) => ({
    ...(await importOriginal<typeof TerminalFileOpenRouting>()),
    openDetectedFilePath: mocks.openDetectedFilePath
  })
)
const localOwner = {
  fileLinkContext: {
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    runtimeEnvironmentId: null,
    sourceTabId: 'tab-1'
  },
  runtimeContext: {
    target: { kind: 'local' as const },
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    expectedExecutionHostId: 'local' as const
  },
  isVisible: true,
  sessionId: 'grok-session'
}
type ImageOwner = NonNullable<
  ComponentProps<typeof NativeChatMarkdownImageOwnerContext.Provider>['value']
>
function Transcript({ content, owner = localOwner }: { content: string; owner?: ImageOwner }) {
  return (
    <TooltipProvider>
      <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
        <NativeChatMarkdown content={content} variant="document" />
      </NativeChatMarkdownImageOwnerContext.Provider>
    </TooltipProvider>
  )
}
beforeEach(() => {
  resetLocalImageSrcStateForTests()
  mocks.callRuntimeRpc.mockReset()
  vi.stubGlobal('IntersectionObserver', undefined)
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    repos: [repoFixture()],
    worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })] },
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: 'local'
  })
  let sequence = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++sequence}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.readRuntimeFilePreview.mockResolvedValue({
    content: 'AA==',
    isBinary: true,
    mimeType: 'image/png'
  })
})
afterEach(() => {
  cleanup()
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('session image source resolution', () => {
  it('keeps source resolution and image bytes on one pairing and never reuses the old host blob', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      exists: true,
      absolutePath: '/session/images/chart.png'
    })
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote' },
        expectedEnvironmentPairingRevision: 7
      }
    }
    const { rerender } = render(<Transcript owner={owner} content="![Chart](images/chart.png)" />)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-1')
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
    expect(mocks.readRuntimeFilePreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 }),
      '/session/images/chart.png',
      expect.anything()
    )
    rerender(
      <Transcript
        owner={{
          ...owner,
          runtimeContext: { ...owner.runtimeContext!, expectedEnvironmentPairingRevision: 8 }
        }}
        content="![Chart](images/chart.png)"
      />
    )
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:image-2'))
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(2)
    expect(mocks.readRuntimeFilePreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedEnvironmentPairingRevision: 8 }),
      '/session/images/chart.png',
      expect.anything()
    )
  })

  it('discards a session lookup after its owner changes', async () => {
    let complete!: (value: unknown) => void
    mocks.callRuntimeRpc
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        })
      )
      .mockResolvedValue({ exists: true, absolutePath: '/new/images/chart.png' })
    const { rerender } = render(
      <Transcript
        owner={{ ...localOwner, sessionId: 'old' }}
        content="![Chart](images/chart.png)"
      />
    )
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1))
    rerender(
      <Transcript
        owner={{ ...localOwner, sessionId: 'new' }}
        content="![Chart](images/chart.png)"
      />
    )
    await screen.findByRole('img')
    await act(async () => {
      complete({ exists: true, absolutePath: '/old/images/chart.png' })
    })
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      '/new/images/chart.png',
      { kind: 'chat-image' }
    )
  })
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/components/editor/document-images/useLocalImageSrc'
import {
  invalidateLocalImageCache as invalidateLocalImageSrcCacheForTests,
  resetLocalImageCacheState as resetLocalImageSrcStateForTests
} from '@/components/editor/document-images/local-image-src-cache'
import { useAppStore } from '@/store'
import * as imageCache from '@/components/editor/document-images/local-image-src-cache'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import {
  NativeChatMarkdownImageOwnerContext,
  NativeChatMarkdownImageOwnerProvider
} from './native-chat-markdown-image-owner'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import {
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/terminal-file-open-routing'
import type * as HttpLinkRouting from '@/lib/http-link-routing'

import * as imageCachePinning from '@/components/editor/document-images/local-image-cache-pinning'
import { ImageVisibilityObserver } from './native-chat-image-visibility-observer.test-fixture'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'

const mocks = vi.hoisted(() => ({
  readRuntimeFilePreview: vi.fn(),
  openDetectedFilePath: vi.fn(),
  openHttpLink: vi.fn()
}))

vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalFileOpenRouting>()),
  openDetectedFilePath: mocks.openDetectedFilePath
}))
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRouting>()),
  openHttpLink: mocks.openHttpLink
}))

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
  isVisible: true
}

type ImageOwner = NonNullable<
  ComponentProps<typeof NativeChatMarkdownImageOwnerContext.Provider>['value']
>

function Transcript({
  content = '| Screenshot |\n| --- |\n| ![Chart](screenshots/chart.png) |',
  owner = localOwner,
  growing = false,
  variant = 'document'
}: {
  content?: string
  owner?: ImageOwner
  growing?: boolean
  variant?: 'document' | 'compact'
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    owner.fileLinkContext,
    rootRef,
    { sessionId: 'session-1', isVisible: owner.isVisible }
  )
  return (
    <TooltipProvider>
      <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
        <div ref={rootRef}>
          <NativeChatLinkClickContext value={onLinkClick}>
            <NativeChatMarkdown content={content} variant={variant} growing={growing} />
          </NativeChatLinkClickContext>
          <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
        </div>
      </NativeChatMarkdownImageOwnerContext.Provider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  const worktree = worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    repos: [repoFixture()],
    worktreesByRepo: { repo: [worktree] },
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

describe('native chat Markdown image preview', () => {
  it('routes image reads and actions through the selected owner provider across owner changes and removal', async () => {
    const original = useAppStore.getState()
    const fixture = nativeChatFanoutFixture(1, 1, 0)
    const workspaceId = nativeChatFanoutWorkspace(0)
    const folders = (owner: string, path: string) =>
      fixture.folderWorkspaces.map((folder) => ({
        ...folder,
        executionHostId: `runtime:${owner}` as const,
        folderPath: path
      }))
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      ...fixture,
      folderWorkspaces: folders('markdown-first', '/remote/first'),
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      runtimeEnvironmentCatalogHydrated: true
    })
    const view = render(
      <TooltipProvider>
        <NativeChatMarkdownImageOwnerProvider tabId="chat-0" isVisible sessionId="session-0">
          <NativeChatMarkdown content="![Chart](chart.png)" variant="document" />
        </NativeChatMarkdownImageOwnerProvider>
      </TooltipProvider>
    )
    try {
      await screen.findByRole('img', { name: 'Chart' })
      expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          target: { kind: 'environment', environmentId: 'markdown-first' },
          worktreeId: workspaceId,
          worktreePath: '/remote/first'
        }),
        '/remote/first/chart.png',
        { kind: 'chat-image' }
      )
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), {
        ctrlKey: true,
        metaKey: true
      })
      expect(mocks.openDetectedFilePath).toHaveBeenLastCalledWith(
        '/remote/first/chart.png',
        null,
        null,
        expect.objectContaining({ worktreeId: workspaceId, runtimeEnvironmentId: 'markdown-first' })
      )

      act(() =>
        useAppStore.setState({ folderWorkspaces: folders('markdown-next', '/remote/next') })
      )
      await waitFor(() =>
        expect(screen.getByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'blob:image-2')
      )
      expect(mocks.readRuntimeFilePreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: { kind: 'environment', environmentId: 'markdown-next' },
          worktreePath: '/remote/next'
        }),
        '/remote/next/chart.png',
        { kind: 'chat-image' }
      )
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), {
        ctrlKey: true,
        metaKey: true
      })
      expect(mocks.openDetectedFilePath).toHaveBeenLastCalledWith(
        '/remote/next/chart.png',
        null,
        null,
        expect.objectContaining({
          worktreeId: workspaceId,
          worktreePath: '/remote/next',
          runtimeEnvironmentId: 'markdown-next'
        })
      )
      mocks.openDetectedFilePath.mockClear()
      await act(async () => useAppStore.setState({ unifiedTabsByWorktree: {} }))
      expect(screen.queryByRole('img', { name: 'Chart' })).toBeNull()
      const unavailableTrigger = screen.getByRole('button', { name: 'View image: Chart' })
      expect(unavailableTrigger).toHaveTextContent('Chart')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(2)
      fireEvent.click(unavailableTrigger, {
        ctrlKey: true,
        metaKey: true
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(2)
      fireEvent.click(unavailableTrigger)
      const unavailableDialog = screen.getByRole('dialog', { name: 'Chart' })
      expect(within(unavailableDialog).getByRole('status')).toHaveTextContent('Preview unavailable')
      expect(within(unavailableDialog).queryByRole('img')).toBeNull()
      expect(within(unavailableDialog).queryByRole('button', { name: 'File actions' })).toBeNull()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      useAppStore.setState(original, true)
    }
  })

  it('loads only visible nearby images and keeps their bytes when they leave the viewport', async () => {
    vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
    const { rerender } = render(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    const trigger = screen.getByRole('button', { name: 'View image: Chart' })
    act(() => ImageVisibilityObserver.current.emit(trigger, true))
    expect(mocks.readRuntimeFilePreview).not.toHaveBeenCalled()
    rerender(<Transcript />)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-1')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 360))
    act(() => ImageVisibilityObserver.current.emit(trigger, false))
    expect(screen.queryByRole('img')).toBeNull()
    expect(trigger).toHaveStyle({ width: '640px', aspectRatio: '640 / 360' })
    act(() => ImageVisibilityObserver.current.emit(trigger, true))
    const returned = await screen.findByRole('img')
    expect(returned).toHaveAttribute('src', 'blob:image-1')
    fireEvent.load(returned)
    expect(trigger.style.width).toBe('')
    rerender(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(trigger).toHaveStyle({ width: '640px', aspectRatio: '640 / 360' })
    rerender(<Transcript />)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-1')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('retries a cache-byte-budget rejection on open after another image releases its lease', async () => {
    vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
    imageCachePinning.pinLocalImageCacheKey('reserved')
    expect(imageCache.cacheLocalImageBlob('reserved', 'blob:reserved', 2 ** 27 - 2)).toBe(true)
    const content = [0, 1, 2].map((i) => `![Chart ${i}](chart-${i}.png)`).join('\n\n')
    const { container } = render(<Transcript content={content} />)
    const triggers = screen.getAllByRole('button')
    expect(mocks.readRuntimeFilePreview).not.toHaveBeenCalled()
    await act(async () => {
      for (const trigger of triggers) {
        ImageVisibilityObserver.current.emit(trigger, true)
      }
    })
    expect(container.querySelectorAll('img')).toHaveLength(2)
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(3)
    act(() => ImageVisibilityObserver.current.emit(triggers[0]!, false))
    fireEvent.click(triggers[2]!)
    const dialog = screen.getByRole('dialog', { name: 'Chart 2' })
    expect(await within(dialog).findByRole('img')).toHaveAttribute('src', 'blob:image-4')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(4)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    act(() => {
      for (const trigger of triggers) {
        ImageVisibilityObserver.current.emit(trigger, false)
      }
    })
    expect(container.querySelectorAll('img')).toHaveLength(0)
    imageCache.unpinLocalImageCache('reserved')
  })

  it('closes stale previews when session metadata resolves or the session changes', () => {
    const { rerender } = render(<Transcript owner={{ ...localOwner, sessionId: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    rerender(<Transcript owner={{ ...localOwner, sessionId: 'session-1' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    rerender(<Transcript owner={{ ...localOwner, sessionId: 'session-2' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a streamed image dialog mounted when later prose arrives', async () => {
    const content = '![Chart](data:image/png;base64,AA==)\n\n'
    const { rerender } = render(<Transcript content={content} growing />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const dialog = screen.getByRole('dialog', { name: 'Chart' })
    rerender(<Transcript content={`${content}More words`} growing />)
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBe(dialog)
  })

  it('retains a closable unavailable preview after image decoding fails', async () => {
    render(<Transcript content="![Chart](chart.png)" />)
    await screen.findByRole('img', { name: 'Chart' })
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.error(within(dialog).getByRole('img'))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Preview unavailable')
    expect(within(dialog).getByRole('button', { name: 'File actions' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('recovers from a failed thumbnail when refreshed image bytes become available', async () => {
    render(<Transcript content="![Chart](chart.png)" />)
    fireEvent.error(await screen.findByRole('img', { name: 'Chart' }))
    expect(screen.queryByRole('img', { name: 'Chart' })).toBeNull()
    act(() => invalidateLocalImageSrcCacheForTests())
    expect(await screen.findByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'blob:image-2')
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
      'src',
      'blob:image-2'
    )
  })

  it('dismisses the nested file menu before the dialog and runs an action after preview closes', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Transcript />
        <input aria-label="Opened editor" />
      </>
    )
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const trigger = screen.getByRole('button', { name: 'File actions' })
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Open file' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    mocks.openDetectedFilePath.mockImplementationOnce(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      screen.getByRole('textbox', { name: 'Opened editor' }).focus()
    })
    await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/repo/worktree/screenshots/chart.png',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', sourceTabId: 'tab-1' })
    )
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Opened editor' })).toHaveFocus()
    )
  })

  it('opens while a remote read is pending and clears image bytes and actions on owner loss', async () => {
    const pendingRead = Promise.withResolvers<{
      content: string
      isBinary: boolean
      mimeType: string
    }>()
    mocks.readRuntimeFilePreview.mockReturnValueOnce(pendingRead.promise)
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote-a' }
      },
      fileLinkContext: { ...localOwner.fileLinkContext, runtimeEnvironmentId: 'remote-a' }
    }
    const { rerender } = render(<Transcript owner={owner} />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'remote-a' } }),
      '/repo/worktree/screenshots/chart.png',
      { kind: 'chat-image' }
    )
    rerender(<Transcript owner={{ ...owner, runtimeContext: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), { ctrlKey: true })
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.queryByRole('button', { name: 'File actions' })).toBeNull()
    await act(async () =>
      pendingRead.resolve({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
    )
    expect(within(screen.getByRole('dialog')).queryByRole('img')).toBeNull()
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledOnce()
  })

  it('closes the preview when the owning chat becomes hidden', () => {
    const { rerender } = render(<Transcript />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    rerender(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Transcript />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  invalidateLocalImageSrcCacheForTests,
  resetLocalImageSrcStateForTests
} from '@/components/editor/useLocalImageSrc'
import { useAppStore } from '@/store'
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
import { getDefaultSettings } from '../../../../shared/constants'

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

class ImageVisibilityObserver implements IntersectionObserver {
  static current: ImageVisibilityObserver
  readonly root = null
  readonly rootMargin = '128px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()
  readonly takeRecords = (): IntersectionObserverEntry[] => []

  constructor(private readonly callback: IntersectionObserverCallback) {
    ImageVisibilityObserver.current = this
  }

  emit(target: Element, isIntersecting: boolean): void {
    const bounds = target.getBoundingClientRect()
    this.callback(
      [
        {
          target,
          isIntersecting,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0
        }
      ],
      this
    )
  }
}

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
          <NativeChatMarkdown
            content={content}
            variant={variant}
            growing={growing}
            onLinkClick={onLinkClick}
            allowFileUriLinks
          />
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
          <NativeChatMarkdown content="![Chart](chart.png)" variant="document" allowFileUriLinks />
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

  it.each([
    ['chart%23v2.png', '/repo/worktree/chart#v2.png'],
    ['chart%3Fv2.png', '/repo/worktree/chart?v2.png'],
    ['chart%2520v2.png', '/repo/worktree/chart%20v2.png']
  ])(
    'reads the literal filename in %s without interpreting it a second time',
    async (src, path) => {
      render(<Transcript content={`![Chart](${src})`} />)
      await screen.findByRole('img', { name: 'Chart' })
      expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ worktreePath: '/repo/worktree' }),
        path,
        { kind: 'chat-image' }
      )
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), {
        ctrlKey: true,
        metaKey: true
      })
      expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(path, null, null, expect.anything())
    }
  )

  it('loads only visible nearby images and releases their bytes when they leave the viewport', async () => {
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
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
    act(() => ImageVisibilityObserver.current.emit(trigger, true))
    const reloaded = await screen.findByRole('img')
    expect(reloaded).toHaveAttribute('src', 'blob:image-2')
    expect(trigger).toHaveStyle({ aspectRatio: '640 / 360' })
    fireEvent.load(reloaded)
    expect(trigger.style.width).toBe('')
    expect(trigger.style.aspectRatio).toBe('')
    rerender(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(trigger).toHaveStyle({ width: '640px', aspectRatio: '640 / 360' })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-2')
    rerender(<Transcript />)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-3')
    expect(trigger).toHaveStyle({ aspectRatio: '640 / 360' })
  })

  it('retries a cache-budget rejection on open after another image releases its lease', async () => {
    vi.stubGlobal('IntersectionObserver', ImageVisibilityObserver)
    const content = Array.from(
      { length: 101 },
      (_, index) => `![Chart ${index}](chart-${index}.png)`
    ).join('\n\n')
    const { container } = render(<Transcript content={content} />)
    const triggers = screen.getAllByRole('button')
    expect(mocks.readRuntimeFilePreview).not.toHaveBeenCalled()
    await act(async () => {
      for (const trigger of triggers) {
        ImageVisibilityObserver.current.emit(trigger, true)
      }
    })
    expect(container.querySelectorAll('img')).toHaveLength(100)
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(101)
    act(() => ImageVisibilityObserver.current.emit(triggers[0]!, false))
    fireEvent.click(triggers[100]!)
    const dialog = screen.getByRole('dialog', { name: 'Chart 100' })
    expect(await within(dialog).findByRole('img')).toHaveAttribute('src', 'blob:image-102')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledTimes(102)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    act(() => {
      for (const trigger of triggers) {
        ImageVisibilityObserver.current.emit(trigger, false)
      }
    })
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(102)
  })

  it.each([false, true])(
    'routes linked HTTP image middle-clicks with openLinksInApp=%s',
    (openLinksInApp) => {
      useAppStore.setState({ settings: { ...getDefaultSettings('/tmp'), openLinksInApp } })
      render(
        <Transcript content="[![Chart](data:image/png;base64,AA==)](https://example.com/details)" />
      )
      fireEvent(
        screen.getByRole('button', { name: 'View image: Chart' }),
        new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
      )
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('menu')).toBeNull()
      expect(mocks.openHttpLink).toHaveBeenCalledExactlyOnceWith('https://example.com/details', {
        allowRemoteInApp: true,
        worktreeId: 'wt-1',
        forceInApp: openLinksInApp,
        forceSystemBrowser: !openLinksInApp,
        sourceOwner: { kind: 'local' },
        linkContext: { linkIntent: null, isCurrentRequest: expect.any(Function) }
      })
    }
  )

  it('keeps file-linked image middle-clicks opening the outer file', () => {
    render(<Transcript content="[![Chart](chart.png)](details.md)" />)
    fireEvent(
      screen.getByRole('button', { name: 'View image: Chart' }),
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/repo/worktree/details.md',
      null,
      null,
      expect.anything()
    )
  })

  it('opens a linked HTTP image in a browser when the runtime owner is unresolved', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(
      <Transcript
        owner={{ ...localOwner, runtimeContext: null }}
        content="[![Chart](data:image/png;base64,AA==)](https://example.com/details)"
      />
    )
    fireEvent(
      screen.getByRole('button', { name: 'View image: Chart' }),
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    )
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/details',
      '_blank',
      'noopener,noreferrer'
    )
    expect(mocks.openHttpLink).not.toHaveBeenCalled()
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

  it.each(['http:', 'https:'])(
    'loads network-path image references using the web page %s scheme',
    async (protocol) => {
      vi.spyOn(window.location, 'protocol', 'get').mockReturnValue(protocol)
      render(<Transcript content="![Chart](//images.example.com/chart.png)" />)
      expect(await screen.findByRole('img')).toHaveAttribute(
        'src',
        `${protocol}//images.example.com/chart.png`
      )
      expect(mocks.readRuntimeFilePreview).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
        'src',
        `${protocol}//images.example.com/chart.png`
      )
    }
  )

  it('preserves network share filesystem reads in a desktop file context', async () => {
    vi.spyOn(window.location, 'protocol', 'get').mockReturnValue('file:')
    render(<Transcript content="![Chart](//server/share/chart.png)" />)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-1')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      '//server/share/chart.png',
      { kind: 'chat-image' }
    )
  })

  it('preserves Windows drive filesystem reads in a web context', async () => {
    vi.spyOn(window.location, 'protocol', 'get').mockReturnValue('https:')
    render(
      <Transcript
        owner={{
          ...localOwner,
          fileLinkContext: { ...localOwner.fileLinkContext, worktreePath: 'C:\\repo' },
          runtimeContext: { ...localOwner.runtimeContext, worktreePath: 'C:\\repo' }
        }}
        content="![Chart](chart.png)"
      />
    )
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:image-1')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'C:/repo/chart.png',
      { kind: 'chat-image' }
    )
  })

  it.each(['actions', 'open', 'none'] as const)(
    'opens a table image immediately with %s link behavior and leaves text links unchanged',
    async (terminalLinkClickBehavior) => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), terminalLinkClickBehavior }
      })
      render(
        <Transcript
          content={'| Screenshot |\n| --- |\n| ![Chart](/tmp/chart.png) |\n\n[Source](src/app.ts)'}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      const dialog = screen.getByRole('dialog', { name: 'Chart' })
      expect(screen.queryByText('Open file')).not.toBeInTheDocument()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(await within(dialog).findByRole('img', { name: 'Chart' })).toHaveAttribute(
        'src',
        'blob:image-1'
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('link', { name: 'Source' }))
      if (terminalLinkClickBehavior === 'actions') {
        expect(screen.getByText('Open file')).toBeInTheDocument()
      } else if (terminalLinkClickBehavior === 'open') {
        expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
          '/repo/worktree/src/app.ts',
          null,
          null,
          expect.anything()
        )
      } else {
        expect(screen.queryByText('Open file')).not.toBeInTheDocument()
        expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      }
    }
  )

  it('uses one keyboard trigger for a linked image and returns focus after Escape', async () => {
    const user = userEvent.setup()
    const { container } = render(<Transcript content="[![Chart](chart.png)](details.md)" />)
    const trigger = screen.getByRole('button', { name: 'View image: Chart' })
    expect(container.querySelector('a button')).toBeNull()
    await screen.findByRole('img', { name: 'Chart' })
    trigger.focus()
    expect(trigger).toHaveFocus()
    await user.keyboard(' ')
    expect(screen.getByRole('dialog', { name: 'Chart' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it('keeps a streamed image dialog mounted when later prose arrives', async () => {
    const content = '![Chart](data:image/png;base64,AA==)\n\n'
    const { rerender } = render(<Transcript content={content} growing />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const dialog = screen.getByRole('dialog', { name: 'Chart' })
    rerender(<Transcript content={`${content}More words`} growing />)
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBe(dialog)
  })

  it.each([
    '[caption ![Chart](chart.png)](details.md)',
    '[**caption ![Chart](chart.png)**](details.md)'
  ])('keeps linked-image caption actions separate from preview in %s', (content) => {
    const { container } = render(<Transcript content={content} />)
    expect(container.querySelector('a button')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'View image: Chart' })
    expect(trigger.closest('[data-native-chat-link-href]')).toHaveAttribute(
      'data-native-chat-link-href',
      'details.md'
    )
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(screen.queryByText('Open file')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('link', { name: 'caption' }))
    expect(screen.getByText('/repo/worktree/details.md')).toBeInTheDocument()
  })

  it.each([
    ['Mac', { metaKey: true }],
    ['Linux', { ctrlKey: true }],
    ['Windows', { ctrlKey: true, shiftKey: true }]
  ] as const)('preserves %s modified image actions', (platform, modifiers) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    render(<Transcript content="![Chart](chart.png)" />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), modifiers)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/repo/worktree/chart.png',
      null,
      null,
      expect.objectContaining({ openWithSystemDefault: 'shiftKey' in modifiers })
    )
  })

  it('uses the host-qualified directory for relative image bytes and file actions', async () => {
    const user = userEvent.setup()
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote-a' },
        worktreePath: '/remote/chat'
      }
    }
    render(<Transcript owner={owner} content="![Chart](chart.png)" />)
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
      'src',
      'blob:image-1'
    )
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'remote-a' } }),
      '/remote/chat/chart.png',
      { kind: 'chat-image' }
    )
    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/remote/chat/chart.png',
      null,
      null,
      expect.objectContaining({ worktreePath: '/remote/chat', runtimeEnvironmentId: 'remote-a' })
    )
  })

  it('uses the same literal image path and owner for modified clicks and preview reads', async () => {
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote-a' },
        worktreePath: '/remote/chat'
      }
    }
    render(<Transcript owner={owner} content="![Chart](screenshots/chart.png:123)" />)
    await screen.findByRole('img', { name: 'Chart' })
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), {
      ctrlKey: true,
      metaKey: true
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/remote/chat/screenshots/chart.png:123',
      null,
      null,
      expect.objectContaining({ worktreePath: '/remote/chat', runtimeEnvironmentId: 'remote-a' })
    )
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

  it('keeps Close usable while the file menu is open', async () => {
    const user = userEvent.setup()
    render(<Transcript />)
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
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

  it.each(['inline', 'reference'])(
    'loads %s file: images and links on the chat host with literal paths and line locations (#30774)',
    async (syntax) => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), terminalLinkClickBehavior: 'open' }
      })
      const owner: ImageOwner = {
        ...localOwner,
        runtimeContext: {
          ...localOwner.runtimeContext,
          target: { kind: 'environment', environmentId: 'remote-a' }
        },
        fileLinkContext: {
          ...localOwner.fileLinkContext,
          runtimeEnvironmentId: 'remote-a'
        }
      }
      render(
        <Transcript
          owner={owner}
          content={
            syntax === 'inline'
              ? [
                  '![Chart](file:///srv/out/report.png%3A7)',
                  '[**![Thumb](file:///srv/out/thumb.png)**](https://example.com/full)',
                  '[Image source](file:///srv/out/report.png%3A7)',
                  '[Download PDF](file:///srv/out/report.pdf#L9)'
                ].join('\n\n')
              : [
                  '![Chart][chart]',
                  '[**![Thumb][thumb]**](https://example.com/full)',
                  '[Image source][chart]',
                  '[Download PDF][report]',
                  '[chart]: file:///srv/out/report.png%3A7',
                  '[thumb]: file:///srv/out/thumb.png',
                  '[report]: file:///srv/out/report.pdf#L9'
                ].join('\n\n')
          }
        />
      )

      expect(
        screen
          .getByRole('button', { name: 'View image: Thumb' })
          .closest('[data-native-chat-link-href]')
      ).toHaveAttribute('data-native-chat-link-href', 'https://example.com/full')
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      expect(
        await within(screen.getByRole('dialog', { name: 'Chart' })).findByRole('img', {
          name: 'Chart'
        })
      ).toHaveAttribute('src', expect.stringMatching(/^blob:/))
      for (const path of ['/srv/out/report.png:7', '/srv/out/thumb.png']) {
        expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
          expect.objectContaining({
            target: { kind: 'environment', environmentId: 'remote-a' }
          }),
          path,
          { kind: 'chat-image' }
        )
      }
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('link', { name: 'Image source' }))
      expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
        '/srv/out/report.png',
        7,
        null,
        expect.objectContaining({ runtimeEnvironmentId: 'remote-a', sourceTabId: 'tab-1' })
      )
      fireEvent.click(screen.getByRole('link', { name: 'Download PDF' }))
      expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
        '/srv/out/report.pdf',
        9,
        null,
        expect.objectContaining({
          runtimeEnvironmentId: 'remote-a'
        })
      )
    }
  )

  it('closes the preview when the owning chat becomes hidden', () => {
    const { rerender } = render(<Transcript />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    rerender(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Transcript />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retains compact trust checks and GitHub attachment fallback', () => {
    const { rerender } = render(
      <Transcript variant="compact" content="![Chart](https://example.com/chart.png)" />
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Chart' })).toBeInTheDocument()
    rerender(<Transcript variant="compact" content="![Chart](file:///srv/out/chart.png)" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Chart' })).toHaveAttribute(
      'href',
      '#orca-native-chat-file-path=%2Fsrv%2Fout%2Fchart.png'
    )
    rerender(
      <Transcript content="![Attachment](https://github.com/user-attachments/assets/secret)" />
    )
    fireEvent.error(screen.getByRole('img', { name: 'Attachment' }))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Attachment' })).toHaveAttribute(
      'href',
      'https://github.com/user-attachments/assets/secret'
    )
  })
})

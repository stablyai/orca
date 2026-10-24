// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import {
  NativeChatResourceOwnerContext,
  type NativeChatResourceOwner
} from './NativeChatResourceOwner'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import {
  invalidateLocalImageSrcCacheForTests,
  resetLocalImageSrcStateForTests
} from '@/components/editor/useLocalImageSrc'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { createRef, useMemo } from 'react'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'
import { NativeChatUserMessageRow } from './NativeChatUserMessageRow'

const mocks = vi.hoisted(() => ({ host: vi.fn(), rpc: vi.fn(), localRead: vi.fn(), open: vi.fn() }))
vi.mock('@/runtime/host-route-call', () => ({ callHostRoute: mocks.host }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: mocks.open
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))

const path = '/mnt/data/jewel-optimization/chart.png'
function owner(environmentId?: string): NativeChatResourceOwner {
  return {
    nativeChatContext: { tabId: 'chat-tab', sessionId: 'session-1' },
    runtimeContext: {
      target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      expectedExecutionHostId: 'local'
    }
  }
}

function Chat({
  resourceOwner,
  content = `![Chart](sandbox:${path})`
}: {
  resourceOwner: NativeChatResourceOwner
  content?: string
}) {
  const environmentId =
    resourceOwner.runtimeContext?.target.kind === 'environment'
      ? resourceOwner.runtimeContext.target.environmentId
      : null
  const { tabId, sessionId } = resourceOwner.nativeChatContext
  const linkContext = useMemo(
    () => ({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      runtimeEnvironmentId: environmentId,
      nativeChatContext: { tabId, sessionId }
    }),
    [environmentId, tabId, sessionId]
  )
  const onLinkClick = useNativeChatFileLinkClick(linkContext)
  return (
    <NativeChatResourceOwnerContext.Provider value={resourceOwner}>
      <NativeChatMarkdown content={content} variant="document" onLinkClick={onLinkClick} />
    </NativeChatResourceOwnerContext.Provider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:host-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.host.mockResolvedValue({
    worktree: 'wt-1',
    absolutePath: path,
    relativePath: null,
    exists: true,
    isDirectory: false,
    openTarget: { kind: 'absolute-file', provider: 'local', absolutePath: path, grantId: 'grant-1' }
  })
  mocks.rpc.mockResolvedValue({
    content: 'AA==',
    isBinary: true,
    isImage: true,
    mimeType: 'image/png'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { readFile: mocks.localRead } }
  })
})
afterEach(async () => {
  cleanup()
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await setRendererUiLanguage('en')
})

describe('native chat sandbox resources', () => {
  it('translates a typed host refusal instead of exposing its English reason', async () => {
    await setRendererUiLanguage('zh')
    mocks.host.mockResolvedValue({
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: path,
      exists: false,
      isDirectory: false
    })
    render(<Chat resourceOwner={owner('host-a')} />)
    await screen.findByText('无法预览图片：会话主机无法提供此文件')
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it.each(['', 'Attached image'])(
    'keeps user attachments on their existing host reader with prose %j',
    async (markdown) => {
      const source = owner('host-a')
      const blocks = [
        {
          type: 'image-ref' as const,
          path: '/home/host/.orca/agent-session-attachments/prompt.png',
          alt: 'Prompt image'
        }
      ]
      render(
        <NativeChatResourceOwnerContext.Provider value={source}>
          <NativeChatUserMessageRow
            message={{ id: 'user-1', role: 'user', blocks, timestamp: null, source: 'transcript' }}
            markdown={markdown}
            prose={blocks}
            rowRef={createRef<HTMLDivElement>()}
            onRefolded={() => {}}
            allowFileUriLinks
            runtimeContext={source.runtimeContext}
          />
        </NativeChatResourceOwnerContext.Provider>
      )
      await screen.findByRole('img', { name: 'Prompt image' })
      expect(mocks.rpc).toHaveBeenCalledWith(
        source.runtimeContext?.target,
        'agentSessionAttachment.read',
        { path: blocks[0].path },
        expect.anything()
      )
      expect(mocks.host).not.toHaveBeenCalled()
      expect(mocks.localRead).not.toHaveBeenCalled()
    }
  )

  it('previews a process image-ref through its conversation grant, not an ungranted read', async () => {
    const source = owner('host-a')
    render(
      <NativeChatResourceOwnerContext.Provider value={source}>
        <NativeChatImageAttachments
          allowHostResources
          blocks={[{ type: 'image-ref', path, alt: 'Viewed chart' }]}
          runtimeContext={source.runtimeContext}
        />
      </NativeChatResourceOwnerContext.Provider>
    )
    await waitFor(() =>
      expect(mocks.host).toHaveBeenCalledWith(
        { target: source.runtimeContext?.target, at: 'local' },
        'files.resolveTerminalPath',
        expect.objectContaining({ pathText: path, nativeChatContext: source.nativeChatContext }),
        expect.anything()
      )
    )
    expect((await screen.findByRole('img', { name: 'Viewed chart' })).getAttribute('src')).toBe(
      'blob:host-image'
    )
    expect(mocks.localRead).not.toHaveBeenCalled()
  })
  it('keeps a granted image and the direct web-image preview in the same message', async () => {
    const source = owner('host-a')
    render(
      <Chat
        resourceOwner={source}
        content={`![Chart](sandbox:${path})\n\n![Web chart](https://example.com/chart.png)`}
      />
    )
    expect((await screen.findByRole('img', { name: 'Chart' })).getAttribute('src')).toBe(
      'blob:host-image'
    )
    fireEvent.click(screen.getByRole('button', { name: 'View image: Web chart' }))
    const dialog = screen.getByRole('dialog', { name: 'Web chart' })
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://example.com/chart.png')
    expect(mocks.host).toHaveBeenCalledWith(
      { target: source.runtimeContext?.target, at: 'local' },
      'files.resolveTerminalPath',
      expect.objectContaining({ pathText: path, nativeChatContext: source.nativeChatContext }),
      expect.anything()
    )
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it('shows localized host errors in a Chinese conversation', async () => {
    await setRendererUiLanguage('zh')
    render(<NativeChatMarkdown content="![Chart](sandbox:/mnt/data/chart.png)" />)
    await screen.findByText(/无法预览图片：会话主机不可用/)
    expect(mocks.localRead).not.toHaveBeenCalled()
  })
  it('keeps ordinary remote images as links in the default compact variant', () => {
    render(<NativeChatMarkdown content="![Remote chart](https://example.com/chart.png)" />)
    expect(screen.queryByRole('img', { name: 'Remote chart' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Remote chart' }).getAttribute('href')).toBe(
      'https://example.com/chart.png'
    )
    expect(mocks.host).not.toHaveBeenCalled()
  })

  it('retains ordinary document image rendering', () => {
    render(
      <NativeChatMarkdown
        variant="document"
        content="![Remote chart](https://example.com/chart.png)"
      />
    )
    expect(screen.getByRole('img', { name: 'Remote chart' }).getAttribute('src')).toBe(
      'https://example.com/chart.png'
    )
    expect(mocks.host).not.toHaveBeenCalled()
  })
  it.each([undefined, 'host-a'])(
    'reads an image from its own %s host using its existing grant',
    async (environmentId) => {
      const source = owner(environmentId)
      render(<Chat resourceOwner={source} />)
      await waitFor(() =>
        expect(screen.getByRole('img', { name: 'Chart' }).getAttribute('src')).toBe(
          'blob:host-image'
        )
      )
      expect(mocks.host).toHaveBeenCalledWith(
        { target: source.runtimeContext?.target, at: 'local' },
        'files.resolveTerminalPath',
        expect.objectContaining({ pathText: path, nativeChatContext: source.nativeChatContext }),
        expect.anything()
      )
      expect(mocks.rpc).toHaveBeenCalledWith(
        source.runtimeContext?.target,
        'files.readTerminalArtifactPreview',
        { worktree: 'id:wt-1', grantId: 'grant-1', absolutePath: path },
        expect.anything()
      )
      expect(mocks.localRead).not.toHaveBeenCalled()
    }
  )

  it.each(['png', 'pdf', 'svg', 'csv'])(
    'opens a %s link through the session file action',
    (extension) => {
      const file = `/mnt/data/result.${extension}`
      render(
        <Chat
          resourceOwner={owner('host-a')}
          content={`[Download ${extension}](sandbox:${file})`}
        />
      )
      const link = screen.getByRole('link', { name: `Download ${extension}` })
      expect(routeNativeChatHref(link.getAttribute('href'))).toMatchObject({
        kind: 'file',
        pathText: file
      })
      fireEvent.click(link, { ctrlKey: true, metaKey: true })
      expect(mocks.open).toHaveBeenCalledWith(
        file,
        null,
        null,
        expect.objectContaining({
          runtimeEnvironmentId: 'host-a',
          nativeChatContext: { tabId: 'chat-tab', sessionId: 'session-1' }
        })
      )
    }
  )

  it('does not substitute a client file after the session host reports a missing artifact', async () => {
    mocks.host.mockResolvedValue({
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: path,
      exists: false,
      isDirectory: false
    })
    render(<Chat resourceOwner={owner('host-a')} />)
    await screen.findByText(/Couldn't preview image/)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.localRead).not.toHaveBeenCalled()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('keeps a disconnected host distinct from a missing image and offers the file action', async () => {
    mocks.host.mockRejectedValue(new Error('Connection lost to host-a'))
    render(<Chat resourceOwner={owner('host-a')} />)
    await screen.findByText(/Connection lost to host-a/)
    fireEvent.click(screen.getByRole('link', { name: 'Chart' }), { ctrlKey: true, metaKey: true })
    expect(mocks.open).toHaveBeenCalledWith(
      path,
      null,
      null,
      expect.objectContaining({ runtimeEnvironmentId: 'host-a', allowClientLocalFallback: false })
    )
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it('never reads when ownership is unresolved', () => {
    render(<Chat resourceOwner={{ ...owner('host-a'), runtimeContext: null }} />)
    expect(screen.getByText(/session host is unavailable/)).toBeTruthy()
    expect(mocks.host).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it('explains an older server refusal without trying this computer', async () => {
    mocks.host.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'request',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' }
      })
    )
    render(<Chat resourceOwner={owner('old-host')} />)
    await screen.findByText(/Update the Orca server/)
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it('does not enable sandbox URLs in unrelated Markdown surfaces or raw HTML', () => {
    const shared = render(<CommentMarkdown content="[File](sandbox:/mnt/data/report.pdf)" />)
    expect(shared.container.querySelector('a')?.getAttribute('href') ?? '').not.toContain(
      'sandbox:'
    )
    shared.unmount()
    const rawContent =
      '<img src="sandbox:/mnt/data/chart.png" /><a href="javascript:alert(1)">Unsafe</a>'
    const chat = render(<Chat resourceOwner={owner('host-a')} content={rawContent} />)
    expect(chat.container.querySelector('img')?.getAttribute('src') ?? '').not.toContain('sandbox:')
    expect(chat.container.querySelector('a')?.getAttribute('href') ?? '').not.toContain(
      'javascript:'
    )
    expect(mocks.host).not.toHaveBeenCalled()
  })

  it('discards a late response from the previous conversation host', async () => {
    let finish: ((value: unknown) => void) | undefined
    mocks.host.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const chat = render(<Chat resourceOwner={owner('host-a')} />)
    await waitFor(() => expect(mocks.host).toHaveBeenCalledOnce())
    chat.rerender(<Chat resourceOwner={owner('host-b')} />)
    await screen.findByRole('img', { name: 'Chart' })
    finish?.({
      worktree: 'wt-1',
      relativePath: 'chart.png',
      absolutePath: '/repo/chart.png',
      exists: true,
      isDirectory: false
    })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
    expect(mocks.rpc.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'host-b' })
  })

  it('refreshes the thumbnail and zoom source after image cache invalidation', async () => {
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce('blob:before-refresh')
      .mockReturnValueOnce('blob:after-refresh')
    render(<Chat resourceOwner={owner('host-a')} />)
    const image = await screen.findByRole('img', { name: 'Chart' })
    expect(image.getAttribute('src')).toBe('blob:before-refresh')
    invalidateLocalImageSrcCacheForTests()
    await waitFor(() => expect(image.getAttribute('src')).toBe('blob:after-refresh'))
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: /^Chart$/ }))
    expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
      'blob:after-refresh'
    )
  })

  it('recovers when the cache is cleared during the first host image read', async () => {
    let finish: ((value: unknown) => void) | undefined
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<Chat resourceOwner={owner('host-a')} />)
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
    invalidateLocalImageSrcCacheForTests()
    const image = await screen.findByRole('img', { name: 'Chart' })
    expect(image.getAttribute('src')).toBe('blob:host-image')
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    await act(async () => {
      finish?.({ content: 'AA==', isBinary: true, isImage: true, mimeType: 'image/png' })
    })
    expect(screen.queryByText(/Couldn't preview image/)).toBeNull()
    expect(screen.getByRole('img', { name: 'Chart' })).toBe(image)
    expect(mocks.localRead).not.toHaveBeenCalled()
  })

  it('keeps a displayed blob and DOM node on an equal owner update', async () => {
    const chat = render(<Chat resourceOwner={owner('host-a')} />)
    const image = await screen.findByRole('img', { name: 'Chart' })
    chat.rerender(<Chat resourceOwner={owner('host-a')} />)
    expect(screen.getByRole('img', { name: 'Chart' })).toBe(image)
    expect(mocks.rpc).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('retains percent signs and punctuation in a decoded image path', async () => {
    const file = '/mnt/data/plot #1?%20:12.png'
    mocks.host.mockResolvedValue({
      worktree: 'wt-1',
      absolutePath: file,
      relativePath: null,
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: file,
        grantId: 'grant-1'
      }
    })
    render(
      <Chat
        resourceOwner={owner('host-a')}
        content="![Chart](sandbox:/mnt/data/plot%20%231%3F%2520%3A12.png)"
      />
    )
    await screen.findByRole('img', { name: 'Chart' })
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'files.readTerminalArtifactPreview',
      expect.objectContaining({ absolutePath: file }),
      expect.anything()
    )
  })

  it('resolves reference-style image definitions before URL sanitization', async () => {
    render(
      <Chat resourceOwner={owner('host-a')} content={`![Chart][plot]\n\n[plot]: sandbox:${path}`} />
    )
    await screen.findByRole('img', { name: 'Chart' })
    expect(mocks.rpc).toHaveBeenCalledOnce()
  })
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/terminal-file-open-routing'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { useAppStore } from '@/store'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  readRuntimeFilePreview: vi.fn(),
  openDetectedFilePath: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalFileOpenRouting>()),
  openDetectedFilePath: mocks.openDetectedFilePath
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
        <NativeChatMarkdown content={content} variant="document" allowFileUriLinks />
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
  it('leaves WSL images on the existing guarded reader without an automatic path probe', async () => {
    render(
      <Transcript
        owner={{
          ...localOwner,
          fileLinkContext: {
            ...localOwner.fileLinkContext,
            worktreePath: '//wsl.localhost/Ubuntu/repo'
          },
          runtimeContext: {
            ...localOwner.runtimeContext,
            worktreePath: '//wsl.localhost/Ubuntu/repo'
          }
        }}
        content="![Chart](images/chart.png)"
      />
    )
    await screen.findByRole('img')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      '//wsl.localhost/Ubuntu/repo/images/chart.png',
      { kind: 'chat-image' }
    )
  })
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
  it('loads session screenshots and uses the selected literal path for preview and file actions', async () => {
    const path = '/home/test/.grok/sessions/%2Frepo/session/images/chart.png'
    mocks.callRuntimeRpc.mockResolvedValue({ exists: true, isDirectory: false, absolutePath: path })
    render(
      <Transcript
        owner={{ ...localOwner, sessionId: 'grok-session' }}
        content="![Chart](images/chart.png)"
      />
    )
    await screen.findByRole('img', { name: 'Chart' })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'files.resolveTerminalPath',
      expect.objectContaining({
        pathText: 'images/chart.png',
        nativeChatContext: { tabId: 'tab-1', sessionId: 'grok-session' }
      }),
      expect.anything()
    )
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(expect.anything(), path, {
      kind: 'chat-image'
    })
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), { metaKey: true })
    expect(mocks.openDetectedFilePath).toHaveBeenLastCalledWith(path, null, null, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/)
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenLastCalledWith(path, null, null, expect.anything())
  })

  it.each(['matched', 'missing'] as const)(
    'retains an already loaded workspace image during expansion until refresh settles %s',
    async (settlement) => {
      const originalPath = '/repo/worktree/images/chart.png'
      const nextPath = '/session/images/chart.png'
      let complete!: (value: { exists: boolean; absolutePath: string | null }) => void
      mocks.callRuntimeRpc
        .mockResolvedValueOnce({ exists: true, absolutePath: originalPath })
        .mockReturnValueOnce(
          new Promise((resolve) => {
            complete = resolve
          })
        )
      render(<Transcript content="![Chart](images/chart.png)" />)
      const thumbnail = await screen.findByRole('img', { name: 'Chart' })
      const originalSrc = thumbnail.getAttribute('src')
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2))
      const dialog = screen.getByRole('dialog')
      expect(thumbnail).toHaveAttribute('src', originalSrc)
      expect(within(dialog).getByRole('img')).toHaveAttribute('src', originalSrc)
      expect(within(dialog).queryByText('Preview unavailable')).not.toBeInTheDocument()
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'File actions' }))
      await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
      expect(mocks.openDetectedFilePath).toHaveBeenLastCalledWith(
        originalPath,
        null,
        null,
        expect.anything()
      )
      await act(async () =>
        complete({
          exists: settlement === 'matched',
          absolutePath: settlement === 'matched' ? nextPath : null
        })
      )
      if (settlement === 'matched') {
        await waitFor(() =>
          expect(screen.getByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'blob:image-2')
        )
        expect(mocks.readRuntimeFilePreview).toHaveBeenLastCalledWith(expect.anything(), nextPath, {
          kind: 'chat-image'
        })
      } else {
        await waitFor(() =>
          expect(screen.queryByRole('img', { name: 'Chart' })).not.toBeInTheDocument()
        )
      }
    }
  )

  it('retries a missing live session image on expand without reading a workspace decoy', async () => {
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({ exists: false, absolutePath: null })
      .mockResolvedValue({ exists: true, absolutePath: '/session/images/chart.png' })
    render(
      <Transcript
        owner={{ ...localOwner, sessionId: 'grok-session' }}
        content="![Chart](images/chart.png)"
      />
    )
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1))
    expect(mocks.readRuntimeFilePreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    await within(screen.getByRole('dialog')).findByRole('img')
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      '/session/images/chart.png',
      { kind: 'chat-image' }
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

  it.each([2, 20])(
    'bounds %i session image resolutions to visible sources and explicit retries',
    async (count) => {
      mocks.callRuntimeRpc.mockImplementation(async (_target, _method, params) => ({
        exists: true,
        absolutePath: `/session/${params.pathText}`
      }))
      const content = Array.from(
        { length: count },
        (_, i) => `![Image ${i}](images/chart-${i}.png)`
      ).join('\n\n')
      const owner = { ...localOwner, sessionId: 'grok-session' }
      const { rerender } = render(
        <Transcript owner={{ ...owner, isVisible: false }} content={content} />
      )
      expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
      rerender(<Transcript owner={owner} content={content} />)
      await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(count))
      rerender(<Transcript owner={{ ...owner }} content={content} />)
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(count)
    }
  )
})

// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/components/editor/document-images/useLocalImageSrc'
import { resetLocalImageCacheState as resetLocalImageSrcStateForTests } from '@/components/editor/document-images/local-image-src-cache'
import { useAppStore } from '@/store'

import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import {
  NativeChatMarkdownImageOwnerContext,
  NativeChatMarkdownImageOwnerProvider
} from './native-chat-markdown-image-owner'
import { useNativeChatLinkActions } from '../../links/actions/use-native-chat-link-actions'
import {
  nativeChatFanoutFixture,
  nativeChatFanoutWorkspace,
  repoFixture,
  worktreeFixture
} from '../../surfaces/integration/native-chat-workspace-test-fixtures'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import type * as HttpLinkRouting from '@/lib/browser/navigation/http-link-routing'

import { NativeChatLinkClickContext } from '../../links/actions/native-chat-link-click-context'

const mocks = vi.hoisted(() => ({
  readRuntimeFilePreview: vi.fn(),
  openDetectedFilePath: vi.fn(),
  openHttpLink: vi.fn()
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
vi.mock('@/lib/browser/navigation/http-link-routing', async (importOriginal) => ({
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

  it('shows an image a reply links to under its paragraph and keeps the link', async () => {
    render(
      <Transcript
        content={
          'Done. [Download the edited image](out/edited.png) and the [notes](out/notes.md).\n\n[remote](//example.com/r.png) [web](https://example.com/w.png)'
        }
      />
    )
    const trigger = await screen.findByRole('button', { name: 'View image: edited.png' })
    const image = await within(trigger).findByRole('img')
    expect(image).toHaveAttribute('src', 'blob:image-1')
    // The linked file is read on the chat's host, by its worktree path.
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.anything(),
      '/repo/worktree/out/edited.png',
      { kind: 'chat-image' }
    )
    expect(screen.getByText('Download the edited image').closest('a')).not.toBeNull()
    expect(screen.getByText('notes').closest('a')).not.toBeNull()
    // Web and protocol-relative links stay links; nothing is fetched from them.
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^View image/ })).toHaveLength(1)
  })

  it('keeps each linked image in its own list item', async () => {
    render(<Transcript content={'- [first](shots/a.png)\n- [second](shots/b.png)'} />)
    const items = screen.getAllByRole('listitem')
    expect(
      await within(items[0]!).findByRole('button', { name: 'View image: a.png' })
    ).toBeInTheDocument()
    expect(within(items[1]!).getByRole('button', { name: 'View image: b.png' })).toBeInTheDocument()
    expect(within(items[0]!).getByText('first').closest('a')).not.toBeNull()
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

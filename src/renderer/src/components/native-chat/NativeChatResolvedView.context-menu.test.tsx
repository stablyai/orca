// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

type RetainedSessionFixture = Pick<NativeChatLiveSession, 'status'> & {
  messages: NativeChatMessage[]
}

const mocks = vi.hoisted(() => {
  const session: RetainedSessionFixture = { messages: [], status: 'ready' }
  return {
    fetch: vi.fn(),
    convertImageBlobToPng: vi.fn(),
    writeClipboardImage: vi.fn(),
    writeClipboardText: vi.fn(),
    session,
    success: vi.fn(),
    error: vi.fn()
  }
})

vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: (): NativeChatLiveSession => ({
    messages: mocks.session.messages,
    status: mocks.session.status,
    sessionId: 'session-menu',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  })
}))
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: () => (
    <>
      <NativeChatImageAttachmentPreview
        number={1}
        attachment={{ id: 'image-menu', path: '/tmp/original.png', previewUrl: 'data:thumbnail' }}
        onRemove={vi.fn()}
      />
      <p>Chat text</p>
    </>
  )
}))
vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: () => 'blob:original'
}))
vi.mock('@/lib/image-blob-png', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBlobPng>()),
  convertImageBlobToPng: mocks.convertImageBlobToPng
}))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')
const { TooltipProvider } = await import('@/components/ui/tooltip')

function RetainedBridgeChat({ visible = true }: { visible?: boolean }) {
  return (
    <div
      data-testid="retained-owner"
      style={{ display: visible ? 'block' : 'none' }}
      inert={!visible}
    >
      <NativeChatResolvedView
        paneKey="tab-menu:leaf-menu"
        agent="claude"
        sessionId="session-menu"
        transcriptPath={null}
        isVisible={visible}
        isFocusedGroup={false}
        targetPtyId={null}
        terminalTabId="tab-menu"
        ownsTabWideLaunchDraft={false}
      />
    </div>
  )
}

beforeEach(() => {
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubGlobal('api', {
    ui: {
      writeClipboardImage: mocks.writeClipboardImage,
      writeClipboardText: mocks.writeClipboardText
    }
  })
  mocks.writeClipboardText.mockResolvedValue(undefined)
  mocks.session = { messages: [], status: 'ready' }
  mocks.convertImageBlobToPng.mockImplementation(async (blob: Blob) => blob)
  mocks.writeClipboardImage.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('NativeChatResolvedView image menu ownership', () => {
  it('refuses image capture from a portaled preview while its retained owner is hidden', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['original image']) })
    const view = render(<RetainedBridgeChat />)
    fireEvent.click(screen.getByRole('button', { name: 'Image #1: View image: original.png' }))
    const preview = screen.getByRole('dialog')
    expect(screen.getByTestId('retained-owner').contains(preview)).toBe(false)

    view.rerender(<RetainedBridgeChat visible={false} />)
    fireEvent.contextMenu(within(preview).getByRole('img'))

    expect(mocks.fetch).not.toHaveBeenCalled()
    view.rerender(<RetainedBridgeChat />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(mocks.writeClipboardImage).not.toHaveBeenCalled()
  })

  it('closes the image preview on the first Close click while its copy menu is open', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['original image']) })
    render(<RetainedBridgeChat />)
    fireEvent.click(screen.getByRole('button', { name: 'Image #1: View image: original.png' }))
    const preview = screen.getByRole('dialog', { name: 'original.png' })
    fireEvent.contextMenu(within(preview).getByRole('img'))
    await screen.findByRole('menuitem', { name: 'Copy image' })
    const close = within(preview).getByRole('button', { name: 'Close' })

    fireEvent.pointerDown(close, { button: 0 })
    fireEvent.pointerUp(close, { button: 0 })
    fireEvent.click(close)

    await waitFor(() => expect(preview).not.toBeInTheDocument())
    expect(mocks.writeClipboardImage).not.toHaveBeenCalled()
  })

  it('copies the original image through the visible bridge chat menu', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['original image']) })
    render(<RetainedBridgeChat />)

    fireEvent.contextMenu(screen.getByRole('img', { name: 'original.png' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy image' }))

    await waitFor(() =>
      expect(mocks.writeClipboardImage).toHaveBeenCalledWith(
        `data:image/png;base64,${Buffer.from('original image').toString('base64')}`
      )
    )
    expect(mocks.fetch).toHaveBeenCalledWith('blob:original')
    expect(mocks.success).toHaveBeenCalledWith('Image copied')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('removes the portaled menu and captured image when the retained bridge owner hides', async () => {
    const capturedImage = Promise.withResolvers<Blob>()
    mocks.fetch.mockResolvedValue({ ok: true, blob: () => capturedImage.promise })
    const view = render(<RetainedBridgeChat />)
    const owner = screen.getByTestId('retained-owner')
    const chatRoot = owner.querySelector('[data-native-chat-root]')

    fireEvent.contextMenu(screen.getByRole('img', { name: 'original.png' }))
    const copyAction = await screen.findByRole('menuitem', { name: 'Copy image' })
    const portaledMenu = screen.getByRole('menu')
    expect(owner.contains(portaledMenu)).toBe(false)
    expect(portaledMenu.closest('[inert]')).toBeNull()
    expect(mocks.fetch).toHaveBeenCalledWith('blob:original')

    // Hide without outside focus/pointer events, which can mask missing caller visibility.
    view.rerender(<RetainedBridgeChat visible={false} />)
    expect(owner.querySelector('[data-native-chat-root]')).toBe(chatRoot)
    await waitFor(() => expect(portaledMenu).not.toBeInTheDocument())
    expect(screen.queryByRole('menuitem', { name: 'Copy image', hidden: true })).toBeNull()

    await act(async () => capturedImage.resolve(new Blob(['hidden image'])))
    fireEvent.click(copyAction)
    view.rerender(<RetainedBridgeChat />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByText('Chat text'))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Copy image' })).toBeNull()
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.convertImageBlobToPng).not.toHaveBeenCalled()
    expect(mocks.writeClipboardImage).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })
})

function chatMessage(id: string, role: 'user' | 'assistant', text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

const REPLY = [
  'Run the build:',
  '',
  '```sh',
  'pnpm build',
  '```',
  '',
  '::orca-visual{file="chart.html"}'
].join('\n')

describe('NativeChatResolvedView right-click targets', () => {
  let restoreViewport = (): void => {}
  beforeEach(() => {
    restoreViewport = installNativeChatMessageListTestViewport()
  })
  afterEach(() => restoreViewport())

  it('copies a reply and its code block with the text their hover buttons copy', async () => {
    mocks.session.messages = [
      chatMessage('ask', 'user', 'Fix the build'),
      chatMessage('reply', 'assistant', REPLY)
    ]
    render(
      <TooltipProvider>
        <RetainedBridgeChat />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByText('Run the build:'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy message' }))
    expect(mocks.writeClipboardText).toHaveBeenLastCalledWith(
      'Run the build:\n\n```sh\npnpm build\n```'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    const hoverCopy = mocks.writeClipboardText.mock.lastCall
    fireEvent.contextMenu(screen.getByText('pnpm build'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy code' }))
    expect(mocks.writeClipboardText.mock.lastCall).toEqual(hoverCopy)
    expect(hoverCopy).toEqual(['pnpm build\n'])

    fireEvent.contextMenu(screen.getByText('Fix the build'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy message' }))
    expect(mocks.writeClipboardText).toHaveBeenLastCalledWith('Fix the build')
  })

  it('offers no message copy on a reply still being written, as its hover controls are hidden', async () => {
    mocks.session = {
      messages: [
        chatMessage('ask', 'user', 'Fix the build'),
        chatMessage('reply', 'assistant', 'Working on it')
      ],
      status: 'working'
    }
    render(
      <TooltipProvider>
        <RetainedBridgeChat />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByText('Working on it'))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Copy message' })).toBeNull()
  })
})

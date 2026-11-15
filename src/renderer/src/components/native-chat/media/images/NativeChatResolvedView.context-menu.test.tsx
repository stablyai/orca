import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { isValidElement, type ComponentProps } from 'react'
import type { NativeChatCrewFrame } from '../../../orchestration-crew/NativeChatCrewPanel'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ImageBlobPng from '@/lib/clipboard/images/image-blob-png'
import { NativeChatImageAttachmentPreview } from '../../attachments/chips/NativeChatImageAttachmentPreview'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

type RetainedSessionFixture = Pick<NativeChatLiveSession, 'status'> & {
  messages: NativeChatMessage[]
}

const mocks = vi.hoisted(() => {
  const session: RetainedSessionFixture = { messages: [], status: 'ready' }
  return {
    crewVisibility: vi.fn(),
    fetch: vi.fn(),
    convertImageBlobToPng: vi.fn(),
    writeClipboardImage: vi.fn(),
    writeClipboardText: vi.fn(),
    session,
    success: vi.fn(),
    error: vi.fn()
  }
})

vi.mock('../../../orchestration-crew/NativeChatCrewPanel', () => ({
  NativeChatCrewFrame: ({ panel, children }: ComponentProps<typeof NativeChatCrewFrame>) => {
    mocks.crewVisibility(isValidElement<{ isVisible?: boolean }>(panel) && panel.props.isVisible)
    return children
  }
}))
vi.mock('../../../orchestration-crew/TerminalChatCrewPanel', () => ({
  TerminalChatCrewPanel: () => null
}))

vi.mock('../../session/terminal/read/use-native-chat-retained-session', () => ({
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
vi.mock('../../composer/NativeChatComposer', () => ({
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
vi.mock('@/components/editor/document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: () => 'blob:original'
}))
vi.mock('@/lib/clipboard/images/image-blob-png', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBlobPng>()),
  convertImageBlobToPng: mocks.convertImageBlobToPng
}))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))

const { NativeChatResolvedView } = await import('../../NativeChatResolvedView')
const { useAppStore } = await import('../../../../store/index')

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
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    nativeChatLaunchPromptByTabId: {}
  })
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
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    nativeChatLaunchPromptByTabId: {}
  })
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('NativeChatResolvedView image menu ownership', () => {
  it('removes the portaled menu and captured image when the retained bridge owner hides', async () => {
    const capturedImage = Promise.withResolvers<Blob>()
    mocks.fetch.mockResolvedValue({ ok: true, blob: () => capturedImage.promise })
    const view = render(<RetainedBridgeChat />)
    expect(mocks.crewVisibility).toHaveBeenLastCalledWith(true)
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
    expect(mocks.crewVisibility).toHaveBeenLastCalledWith(false)
    expect(owner.querySelector('[data-native-chat-root]')).toBe(chatRoot)
    await waitFor(() => expect(portaledMenu).not.toBeInTheDocument())
    expect(screen.queryByRole('menuitem', { name: 'Copy image', hidden: true })).toBeNull()

    await act(async () => capturedImage.resolve(new Blob(['hidden image'])))
    fireEvent.click(copyAction)
    view.rerender(<RetainedBridgeChat />)
    expect(mocks.crewVisibility).toHaveBeenLastCalledWith(true)
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

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { NativeChatImageAttachments } from './NativeChatTranscriptChrome'
import { NativeChatResolvedView } from './NativeChatResolvedView'

const { imageContext, readFile, session } = vi.hoisted(() => ({
  imageContext: vi.fn<() => RuntimeFileOperationArgs | null>(),
  readFile: vi.fn(),
  session: {
    agent: 'claude' as const,
    sessionId: 'image-session',
    status: 'ready' as const,
    readPhase: 'ready' as const,
    messages: [
      {
        id: 'image-message',
        role: 'user' as const,
        timestamp: 1,
        source: 'transcript' as const,
        blocks: [{ type: 'image-ref' as const, path: '/tmp/orca-paste-preview.png' }]
      }
    ],
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn()
  }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: imageContext
}))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => session
}))
vi.mock('./use-native-chat-launch-draft-adoption', () => ({
  useNativeChatLaunchDraftSignal: () => ({})
}))
vi.mock('./use-native-chat-composer-reveal-focus', () => ({
  useNativeChatComposerRevealFocus: vi.fn()
}))
vi.mock('./use-native-chat-font-scale', () => ({ useNativeChatFontScale: () => ({ scale: 1 }) }))
vi.mock('./use-native-chat-can-send', () => ({ useNativeChatCanSend: () => false }))
vi.mock('./use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({ cancel: vi.fn() })
}))
vi.mock('./use-native-chat-file-link-context', () => ({ useNativeChatFileLinkContext: () => null }))
vi.mock('./use-native-chat-paste-bridge', () => ({ useNativeChatPasteBridge: () => vi.fn() }))
vi.mock('./use-native-chat-context-menu', () => ({
  emptyNativeChatContextMenuActions: {},
  useNativeChatContextMenu: () => ({
    menu: null,
    onSelectionCapture: vi.fn(),
    onContextMenuCapture: vi.fn()
  })
}))
vi.mock('./use-native-chat-link-actions', () => ({
  useNativeChatLinkActions: () => ({
    onLinkClick: vi.fn(),
    linkActionRequest: null,
    closeLinkActions: vi.fn()
  })
}))
vi.mock('@/components/link-actions/LinkActionPopover', () => ({ LinkActionPopover: () => null }))
vi.mock('./NativeChatComposer', () => ({ NativeChatComposer: () => null }))
vi.mock('./NativeChatInteractiveCard', () => ({ NativeChatInteractiveCard: () => null }))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: ({
    session: transcript,
    runtimeContext
  }: {
    session: NativeChatSession
    runtimeContext?: RuntimeFileOperationArgs | null
  }) => (
    <NativeChatImageAttachments
      blocks={transcript.messages.flatMap((message) => message.blocks)}
      runtimeContext={runtimeContext}
    />
  )
}))

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('api', { fs: { readFile } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:terminal-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  readFile.mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  imageContext.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'image-workspace',
    worktreePath: '/repo/image-workspace',
    expectedExecutionHostId: 'local'
  })
})

afterEach(() => {
  cleanup()
  resetLocalImageSrcStateForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function renderTerminalChat() {
  return render(
    <NativeChatResolvedView
      paneKey="image-tab:leaf"
      terminalTabId="image-tab"
      targetPtyId={null}
      agent="claude"
      sessionId="image-session"
      transcriptPath={null}
      isVisible
      isFocusedGroup={false}
      ownsTabWideLaunchDraft={false}
    />
  )
}

it('shows and opens an existing image through the terminal chat view', async () => {
  const { container } = renderTerminalChat()
  await waitFor(() =>
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:terminal-image')
  )
  fireEvent.click(screen.getByRole('button', { name: 'View image: Pasted image' }))
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
    'blob:terminal-image'
  )
  expect(imageContext).toHaveBeenCalledWith('image-tab')
  expect(readFile).toHaveBeenCalledOnce()
})

it('waits for the image owner and then recovers without reopening the conversation', async () => {
  imageContext.mockReturnValue(null)
  const view = renderTerminalChat()
  expect(readFile).not.toHaveBeenCalled()
  expect(view.container.querySelector('img')).toBeNull()
  imageContext.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'image-workspace',
    worktreePath: '/repo/image-workspace',
    expectedExecutionHostId: 'local'
  })
  view.rerender(
    <NativeChatResolvedView
      paneKey="image-tab:leaf"
      terminalTabId="image-tab"
      targetPtyId={null}
      agent="claude"
      sessionId="image-session"
      transcriptPath={null}
      isVisible
      isFocusedGroup={false}
      ownsTabWideLaunchDraft={false}
    />
  )
  await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
})

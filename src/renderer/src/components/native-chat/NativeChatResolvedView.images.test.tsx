// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { useAppStore } from '@/store'
import { nativeChatFanoutFixture } from './native-chat-workspace-test-fixtures'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'user-image',
      role: 'user',
      blocks: [{ type: 'image-ref', path: '/repo/0/orca-paste-shot.png' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-image',
  agent: 'claude',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => session
}))
vi.mock('./NativeChatComposer', () => ({ NativeChatComposer: () => null }))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const original = useAppStore.getState()
const readFile = vi.fn()
let restoreViewport = (): void => {}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  resetLocalImageSrcStateForTests()
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:terminal-image')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  readFile.mockResolvedValue({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
  vi.stubGlobal('api', { ...window.api, fs: { ...window.api?.fs, readFile } })
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    ...nativeChatFanoutFixture(0, 1, 1),
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironmentCatalogHydrated: true
  })
})

afterEach(() => {
  cleanup()
  restoreViewport()
  resetLocalImageSrcStateForTests()
  useAppStore.setState(original, true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  readFile.mockReset()
})

it('previews a terminal transcript image from the terminal tab’s workspace owner', async () => {
  render(
    <NativeChatResolvedView
      paneKey="terminal-0-0:leaf"
      agent="claude"
      sessionId="session-image"
      transcriptPath={null}
      isVisible
      isFocusedGroup={false}
      targetPtyId={null}
      terminalTabId="terminal-0-0"
      ownsTabWideLaunchDraft={false}
    />
  )
  const preview = await screen.findByRole('button', { name: 'View image: Pasted image' })
  await waitFor(() =>
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('blob:terminal-image')
  )
  expect(readFile).toHaveBeenCalledExactlyOnceWith({
    filePath: '/repo/0/orca-paste-shot.png',
    connectionId: undefined,
    access: { kind: 'chat-image' }
  })
})

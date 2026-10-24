// @vitest-environment happy-dom
import { useContext, type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NativeChatView from './NativeChatView'
import { NativeChatResourceOwnerContext } from './NativeChatResourceOwner'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

const owner = vi.hoisted(() => ({
  target: { kind: 'environment' as const, environmentId: 'host-a' },
  worktreeId: 'wt-1',
  worktreePath: '/host/repo',
  expectedExecutionHostId: 'local' as const
}))

function PassThrough({ children }: { children: ReactNode }) {
  return children
}

function OwnerProbe() {
  const resource = useContext(NativeChatResourceOwnerContext)
  const image = useContext(NativeChatMarkdownImageOwnerContext)
  return <output>{JSON.stringify({ resource, image })}</output>
}

vi.mock('./NativeChatPaneFileDropSurface', () => ({ NativeChatPaneFileDropSurface: PassThrough }))
vi.mock('./native-chat-visual-owner', () => ({ NativeChatVisualOwnerProvider: PassThrough }))
vi.mock('./use-native-chat-file-link-existence', () => ({
  NativeChatFileLinkExistenceProvider: PassThrough
}))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => owner
}))
vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: (tabId: string) => ({
    worktreeId: 'wt-1',
    worktreePath: '/host/repo',
    runtimeEnvironmentId: 'host-a',
    sourceTabId: tabId
  })
}))
vi.mock('./NativeChatStructuredSession', () => ({ NativeChatStructuredSession: OwnerProbe }))
vi.mock('./NativeChatResolvedView', () => ({ NativeChatResolvedView: OwnerProbe }))
vi.mock('./use-native-chat-status-entry', () => ({
  useNativeChatStatusEntry: () => ({ paneKey: 'chat-tab:leaf', entry: undefined })
}))
vi.mock('./NativeChatSessionGate', () => ({
  NativeChatSessionGate: ({ children }: { children: (value: unknown) => ReactNode }) =>
    children({
      paneKey: 'chat-tab:leaf',
      agent: 'codex',
      sessionId: 'session-1',
      transcriptPath: null
    })
}))

afterEach(cleanup)

describe('native chat resource and image owners', () => {
  it.each(['structured', 'bridge'] as const)('keeps both owners in the %s conversation', (mode) => {
    const view = render(
      mode === 'structured' ? (
        <NativeChatView
          mode="structured"
          tabId="chat-tab"
          sessionId="session-1"
          target={owner.target}
          agent="codex"
          isVisible
          isFocusedGroup
        />
      ) : (
        <NativeChatView terminalTabId="chat-tab" isVisible isFocusedGroup ownsTabWideLaunchDraft />
      )
    )
    const readOwners = () => JSON.parse(screen.getByRole('status').textContent ?? '{}')
    expect(readOwners()).toEqual({
      resource: {
        runtimeContext: owner,
        nativeChatContext: { tabId: 'chat-tab', sessionId: 'session-1' }
      },
      image: {
        fileLinkContext: {
          worktreeId: 'wt-1',
          worktreePath: '/host/repo',
          runtimeEnvironmentId: 'host-a',
          sourceTabId: 'chat-tab'
        },
        runtimeContext: owner,
        isVisible: true,
        sessionId: 'session-1'
      }
    })
    view.unmount()
  })
})

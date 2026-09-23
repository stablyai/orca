// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// The transcript source and the two input surfaces are stubbed; the wire under
// test is store status -> resolved view -> message list -> transcript tail.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('./NativeChatComposer', () => ({ NativeChatComposer: () => null }))
vi.mock('./NativeChatInteractiveCard', () => ({ NativeChatInteractiveCard: () => null }))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')

const paneKey = 'tab-state:leaf-state'
let restoreViewport = (): void => {}

function transcript(status: NativeChatLiveSession['status']): NativeChatLiveSession {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Rename the module' }],
        timestamp: 1,
        source: 'transcript'
      }
    ],
    status,
    sessionId: 'session-state',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function renderPane(): void {
  render(
    <NativeChatResolvedView
      paneKey={paneKey}
      agent="claude"
      sessionId="session-state"
      transcriptPath={null}
      isVisible
      isFocusedGroup={false}
      targetPtyId="pty-state"
      terminalTabId="tab-state"
      ownsTabWideLaunchDraft={false}
    />
  )
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

// A terminal-backed pane holds its agent's coarse state and, until now, rendered
// none of it: a blocked agent and an idle one looked identical (STA-6222,
// STA-6980), and the host-stamped clock the view already passed was discarded.
describe('NativeChatResolvedView agent state', () => {
  it('says the agent is waiting on the reader when the pane status is blocked', () => {
    retained.session = transcript('ready')
    useAppStore.getState().setAgentStatus(paneKey, {
      state: 'blocked',
      prompt: 'Rename the module',
      agentType: 'claude'
    })

    renderPane()

    expect(screen.getByText('Waiting for your input')).toBeInTheDocument()
  })

  it('says the same for a pane waiting on a permission decision', () => {
    retained.session = transcript('ready')
    useAppStore.getState().setAgentStatus(paneKey, {
      state: 'waiting',
      prompt: 'Rename the module',
      agentType: 'claude'
    })

    renderPane()

    expect(screen.getByText('Waiting for your input')).toBeInTheDocument()
  })

  it('reports elapsed work from the host-stamped epoch the view already held', () => {
    retained.session = transcript('working')
    useAppStore.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'Rename the module',
      agentType: 'claude'
    })
    const live = useAppStore.getState().agentStatusByPaneKey[paneKey]
    if (!live) {
      throw new Error('the store dropped the status row this test depends on')
    }
    useAppStore.setState((store) => ({
      agentStatusByPaneKey: {
        ...store.agentStatusByPaneKey,
        [paneKey]: { ...live, stateStartedAt: Date.now() - 75_000 }
      }
    }))

    renderPane()

    expect(screen.getByText('Working for 1m 15s')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for your input')).toBeNull()
  })

  it('stays quiet on a settled turn', () => {
    retained.session = transcript('ready')
    useAppStore.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'Rename the module',
      agentType: 'claude'
    })

    renderPane()

    expect(screen.queryByText('Waiting for your input')).toBeNull()
    expect(screen.queryByText(/Working for/)).toBeNull()
  })

  it('stays quiet when the pane has no fresh status at all', () => {
    retained.session = transcript('ready')

    renderPane()

    expect(screen.queryByText('Waiting for your input')).toBeNull()
    expect(screen.queryByText(/Working for/)).toBeNull()
  })
})

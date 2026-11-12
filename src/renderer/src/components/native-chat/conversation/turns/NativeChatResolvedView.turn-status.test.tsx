import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type {
  AgentStatusEntry,
  AgentStatusPayload
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'

// Stub transcript/composer to exercise store status through the view into shared turn and prompt rendering.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
vi.mock('../../session/terminal/read/use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('../../composer/NativeChatComposer', () => ({ NativeChatComposer: () => null }))

const { NativeChatResolvedView } = await import('../../NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { useAppStore } = await import('../../../../store/index')
const { installNativeChatMessageListTestViewport } =
  await import('../../viewport/virtualization/native-chat-message-list-test-viewport')

const paneKey = 'tab-state:leaf-state'
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Rename the module' }],
  timestamp: 1,
  source: 'transcript'
}

const stepCall: NativeChatMessage = {
  id: 'step-1',
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'pnpm build' } }],
  timestamp: 3,
  source: 'transcript'
}

// State both reconciled fields so the fixture represents a consistent live session.
function transcript(
  status: NativeChatLiveSession['status'],
  hookAwaitingInput: boolean,
  messages: NativeChatMessage[] = [userTurn]
): NativeChatLiveSession {
  return {
    messages,
    status,
    sessionId: 'session-state',
    agent: 'claude',
    hookAwaitingInput,
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function setStatus(payload: Omit<AgentStatusPayload, 'prompt' | 'agentType'>, age = 0): void {
  useAppStore
    .getState()
    .setAgentStatus(paneKey, { prompt: 'Rename the module', agentType: 'claude', ...payload })
  const live = useAppStore.getState().agentStatusByPaneKey.get(paneKey)
  if (!live) {
    throw new Error('the store dropped the status row this test depends on')
  }
  useAppStore.setState((store) => ({
    agentStatusByPaneKey: acceptedAgentStatuses([
      ...store.agentStatusByPaneKey,
      [paneKey, { ...live, stateStartedAt: Date.now() - age }] as const
    ])
  }))
}

function patchStatus(fields: Partial<AgentStatusEntry>): void {
  useAppStore.setState((store) => ({
    agentStatusByPaneKey: acceptedAgentStatuses([
      ...store.agentStatusByPaneKey,
      [paneKey, { ...store.agentStatusByPaneKey.get(paneKey)!, ...fields }] as const
    ])
  }))
}

function renderPane(): void {
  render(
    <TooltipProvider>
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
    </TooltipProvider>
  )
}

beforeEach(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    nativeChatLaunchPromptByTabId: {}
  })
})

afterEach(() => {
  cleanup()
  restoreViewport()
  useAppStore.setState({
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    nativeChatLaunchPromptByTabId: {}
  })
})

describe('NativeChatResolvedView turn status', () => {
  // Store staleness alone cannot prove an unanswered turn ended.
  it('does not settle a turn the host went quiet on', () => {
    retained.session = transcript('ready', true, [userTurn, stepCall])
    setStatus({ state: 'waiting' }, 60_000)
    patchStatus({ turnStartedAt: Date.now() - 60_000 })

    renderPane()
    expect(screen.getByText('Working for 1m 0s')).toBeInTheDocument()

    // The live session reads no hook state once the row is stale, so the wait no longer holds the turn.
    retained.session = transcript('ready', false, [userTurn, stepCall])
    act(() => {
      patchStatus({ updatedAt: Date.now() - 31 * 60_000 })
    })

    expect(screen.queryByText(/Work(ing|ed) for/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
    expect(screen.getByText('pnpm build')).toBeInTheDocument()
  })
})

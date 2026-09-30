// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { AgentStatusEntry, AgentStatusPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// The transcript source and the composer are stubbed; the wire under test is
// store status -> resolved view -> the shared message list and prompt card.
const retained = vi.hoisted((): { session: NativeChatLiveSession | null } => ({ session: null }))
vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => retained.session
}))
vi.mock('./NativeChatComposer', () => ({ NativeChatComposer: () => null }))

const { NativeChatResolvedView } = await import('./NativeChatResolvedView')
const { useAppStore } = await import('../../store')
const { installNativeChatMessageListTestViewport } =
  await import('./native-chat-message-list-test-viewport')

const paneKey = 'tab-state:leaf-state'
let restoreViewport = (): void => {}

const userTurn: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Rename the module' }],
  timestamp: 1,
  source: 'transcript'
}

const askCall: NativeChatMessage = {
  id: 'ask-1',
  role: 'assistant',
  blocks: [
    {
      type: 'tool-call',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which name?',
            multiSelect: false,
            options: [{ label: 'core' }, { label: 'base' }]
          }
        ]
      }
    }
  ],
  timestamp: 2,
  source: 'transcript'
}

const stepCall: NativeChatMessage = {
  id: 'step-1',
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'pnpm build' } }],
  timestamp: 3,
  source: 'transcript'
}

// `status` and `hookAwaitingInput` are what the live session reconciles from the
// same hook row; the test states both so the view is fed a consistent session.
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
  const live = useAppStore.getState().agentStatusByPaneKey[paneKey]
  if (!live) {
    throw new Error('the store dropped the status row this test depends on')
  }
  useAppStore.setState((store) => ({
    agentStatusByPaneKey: {
      ...store.agentStatusByPaneKey,
      [paneKey]: { ...live, stateStartedAt: Date.now() - age }
    }
  }))
}

function patchStatus(fields: Partial<AgentStatusEntry>): void {
  useAppStore.setState((store) => ({
    agentStatusByPaneKey: {
      ...store.agentStatusByPaneKey,
      [paneKey]: { ...store.agentStatusByPaneKey[paneKey]!, ...fields }
    }
  }))
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

function liveActivityLine(): Element | null {
  return document.querySelector('[data-native-chat-turn-activity]')
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

// A terminal-backed pane renders through the structured chat's own turn-status
// UI: the clock bar under the prompt, the live line at the tail, and the row a
// question uses when the agent waits on the reader.
describe('NativeChatResolvedView turn status', () => {
  it('counts the working turn from the host-stamped epoch, with the live line at the tail', () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' }, 75_000)

    renderPane()

    expect(screen.getByText('Working for 1m 15s')).toBeInTheDocument()
    expect(liveActivityLine()).toHaveTextContent('Working…')
    expect(document.querySelectorAll('.animate-bounce')).toHaveLength(0)
  })

  it.each(['waiting', 'blocked'] as const)(
    'says a %s agent waits on the reader when only its terminal shows the prompt',
    (state) => {
      retained.session = transcript('ready', true)
      setStatus({ state }, 20_000)

      renderPane()

      // A whole phrase: there is no question to name after a colon.
      expect(screen.getByText('Awaiting user input')).toBeInTheDocument()
      expect(liveActivityLine()).toBeNull()
      // The turn runs on behind the wait, as a structured turn does behind its card.
      expect(screen.getByText('Working for 20s')).toBeInTheDocument()
    }
  )

  it('lets the approval card speak for the wait', () => {
    retained.session = transcript('ready', true)
    setStatus({
      state: 'waiting',
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf dist' } })
    })

    renderPane()

    expect(screen.getByText('Allow Bash?')).toBeInTheDocument()
    expect(screen.queryByText(/Awaiting user input/)).toBeNull()
    expect(liveActivityLine()).toBeNull()
    expect(screen.getByText('Working for 0s')).toBeInTheDocument()
  })

  it("keeps a pending question's transcript row awaiting while the agent waits", () => {
    retained.session = transcript('ready', true, [userTurn, askCall])
    setStatus({ state: 'waiting' })

    renderPane()

    // One row says it: the question's own, not a second one at the tail.
    expect(document.querySelectorAll('[data-native-chat-ask-row="awaiting"]')).toHaveLength(1)
    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    expect(screen.getAllByText('Which name?').length).toBeGreaterThan(0)
    expect(screen.queryByText('Asked:')).toBeNull()
  })

  // Answering a terminal-only prompt means leaving the chat, which remounts it on return; a reload
  // also starts the store with no state history. The host's stamp covers both.
  it("counts a turn it first sees after a wait from the host's turn start, not the last state", () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' }, 5_000)
    patchStatus({ turnStartedAt: Date.now() - 90_000, stateHistory: [] })

    renderPane()

    expect(screen.getByText('Working for 1m 30s')).toBeInTheDocument()
  })

  // A background task holds the row 'working' past the last turn's end, so the row's own epoch is
  // that turn's; the host stamps the new turn from the main agent's own prompt.
  it('counts a new turn from its stamp, not a row held open by background work', () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' })
    const now = Date.now()
    patchStatus({
      stateStartedAt: now - 45 * 60_000,
      turnStartedAt: now - 5_000,
      mainAgent: { state: 'working', stateStartedAt: now - 5_000 },
      stateHistory: []
    })

    renderPane()

    expect(screen.getByText('Working for 5s')).toBeInTheDocument()
  })

  it("falls back to the main agent's own clock on a host that stamps no turn", () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' })
    const now = Date.now()
    patchStatus({
      stateStartedAt: now - 45 * 60_000,
      mainAgent: { state: 'working', stateStartedAt: now - 5_000 },
      stateHistory: []
    })

    renderPane()

    expect(screen.getByText('Working for 5s')).toBeInTheDocument()
  })

  // An Esc at a permission prompt fires no hook, then the same text is sent again: a new turn.
  it('counts the same prompt sent again as a new turn', () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' }, 5_000)
    const now = Date.now()
    patchStatus({
      turnStartedAt: now - 5_000,
      stateHistory: [
        { state: 'working', prompt: 'Rename the module', startedAt: now - 600_000 },
        { state: 'waiting', prompt: 'Rename the module', startedAt: now - 500_000 }
      ]
    })

    renderPane()

    expect(screen.getByText('Working for 5s')).toBeInTheDocument()
  })

  // The reader no longer rebuilds a turn from the history, so an old host reads the state's start.
  it('falls back to the current state start on a host that stamps no turn', () => {
    retained.session = transcript('working', false)
    setStatus({ state: 'working' }, 20_000)
    const now = Date.now()
    patchStatus({
      stateHistory: [
        { state: 'working', prompt: 'Rename the module', startedAt: now - 90_000 },
        { state: 'waiting', prompt: 'Rename the module', startedAt: now - 40_000 }
      ]
    })

    renderPane()

    expect(screen.getByText('Working for 20s')).toBeInTheDocument()
  })

  // The host recorded the turn's end, so a pane mounted after it (a switch to the terminal and
  // back) folds it behind its duration instead of drawing it unfinished.
  it('shows the host-ended latest turn with its host duration after a remount', () => {
    retained.session = transcript('ready', false, [userTurn, stepCall])
    setStatus({ state: 'done' })
    // One clock read: the duration is the difference of these two stamps.
    const now = Date.now()
    patchStatus({ stateStartedAt: now - 10_000, turnStartedAt: now - 100_000 })

    renderPane()

    expect(screen.getByText('Worked for 1m 30s')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Toggle turn details' })).toBeInTheDocument()
  })

  // The store's staleness drops a silent row after 30 minutes. A wait left unanswered that long
  // must not read as a finished turn: nothing says it ended.
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

  it('folds finished turns from history behind their transcript duration', () => {
    const at = Date.parse('2026-09-28T10:00:00.000Z')
    retained.session = transcript('ready', false, [
      { ...userTurn, timestamp: at },
      {
        id: 'answer-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Renamed.' }],
        timestamp: at + 45_000,
        source: 'transcript'
      },
      {
        id: 'user-2',
        role: 'user',
        blocks: [{ type: 'text', text: 'Now add tests' }],
        timestamp: at + 100_000,
        source: 'transcript'
      }
    ])
    setStatus({ state: 'done' }, 60_000)

    renderPane()

    expect(screen.getByText('Worked for 45s')).toBeInTheDocument()
    // The latest turn has no recorded end, and this pane never watched it.
    expect(screen.getAllByText(/Work(ing|ed) for/)).toHaveLength(1)
  })

  // The transcript draws no row for harness notices, so they cannot end a turn either.
  it('keeps a running turn open across a harness notice injected mid-turn', () => {
    const at = Date.parse('2026-09-28T10:00:00.000Z')
    retained.session = transcript('working', false, [
      { ...userTurn, timestamp: at },
      {
        id: 'progress-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Starting the build.' }],
        timestamp: at + 10_000,
        source: 'transcript'
      },
      {
        id: 'notice-1',
        role: 'user',
        blocks: [{ type: 'text', text: '<task-notification>\n<task-id>b1</task-id>' }],
        timestamp: at + 20_000,
        source: 'transcript'
      },
      {
        id: 'progress-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Build finished, checking output.' }],
        timestamp: at + 25_000,
        source: 'transcript'
      }
    ])
    setStatus({ state: 'working' }, 30_000)

    renderPane()

    expect(screen.getByText('Working for 30s')).toBeInTheDocument()
    expect(screen.getByText('Starting the build.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
  })

  it('stays quiet on a settled turn it never watched', () => {
    retained.session = transcript('ready', false)
    setStatus({ state: 'done' }, 60_000)

    renderPane()

    expect(screen.queryByText(/Awaiting user input/)).toBeNull()
    expect(screen.queryByText(/Work(ing|ed) for/)).toBeNull()
    expect(liveActivityLine()).toBeNull()
  })

  it('stays quiet when the pane has no status at all', () => {
    retained.session = transcript('ready', false)

    renderPane()

    expect(screen.queryByText(/Awaiting user input/)).toBeNull()
    expect(screen.queryByText(/Work(ing|ed) for/)).toBeNull()
    expect(liveActivityLine()).toBeNull()
  })
})

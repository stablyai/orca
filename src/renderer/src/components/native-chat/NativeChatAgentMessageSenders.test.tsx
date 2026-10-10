// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentMessageSource } from '../../../../shared/agent-session-message-source'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isOrcaSessionId, type OrcaSessionId } from '../../../../shared/orca-session-address'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'

const conversationNames = vi.hoisted(() => new Map<string, string>())
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: (tab: { entityId: string } | undefined) =>
    (tab && conversationNames.get(tab.entityId)) ?? null
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))

const WORKTREE = 'wt-coder'
const TAB = 'tab-coder'
const LEAF = '11111111-1111-4111-8111-111111111111'
const HANDLE = 'term_coder'
const SESSION = orcaSessionId('22222222-2222-4222-8222-222222222222')
const initialState = useAppStore.getInitialState()

function orcaSessionId(id: string): OrcaSessionId {
  if (!isOrcaSessionId(id)) {
    throw new Error(`not a session id: ${id}`)
  }
  return id
}

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB,
    ptyId: 'pty-coder',
    worktreeId: WORKTREE,
    title: 'Claude Code',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function agentRow(terminalHandle: string): AgentStatusEntry {
  return {
    paneKey: `${TAB}:${LEAF}`,
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    terminalHandle,
    worktreeId: WORKTREE,
    tabId: TAB
  }
}

function chatTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'chat-tab',
    entityId: SESSION,
    groupId: 'group',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function source(
  party: Partial<AgentMessageSource['senders'][number]['party']>,
  name: string | null = 'Recorded name'
): AgentMessageSource {
  return {
    kind: 'agent',
    senders: [
      {
        party: { address: HANDLE, terminalHandle: HANDLE, orcaSessionId: null, ...party },
        name
      }
    ],
    orchestration: null
  }
}

function renderSenders(from: AgentMessageSource, queued = false) {
  return render(
    <NativeChatAgentMessageSenders from={from} chatWorktreeId="wt-chat" queued={queued} />
  )
}

beforeEach(() => {
  conversationNames.clear()
  useAppStore.setState({ activeWorktreeId: 'wt-chat', activeWorkspaceExecutionHostId: 'local' })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('the name a sender is shown under', () => {
  it('keeps the host-recorded CLI name even while a different pane title is visible', () => {
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE]: [terminalTab({ customTitle: 'Parser worker' })] },
      agentStatusByPaneKey: { [`${TAB}:${LEAF}`]: agentRow(HANDLE) }
    })
    renderSenders(source({}, 'Recorded name'))
    expect(screen.getByRole('button', { name: 'Recorded name' })).toBeInTheDocument()
    expect(screen.queryByText('Parser worker')).not.toBeInTheDocument()
  })

  it('keeps the recorded CLI name after the terminal is renamed', () => {
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE]: [terminalTab({ customTitle: 'Old name' })] },
      agentStatusByPaneKey: { [`${TAB}:${LEAF}`]: agentRow(HANDLE) }
    })
    renderSenders(source({}), true)
    act(() => {
      useAppStore.setState({
        tabsByWorktree: { [WORKTREE]: [terminalTab({ customTitle: 'New name' })] }
      })
    })
    expect(screen.getByRole('button', { name: 'Recorded name' })).toBeInTheDocument()
    expect(screen.queryByText('New name')).not.toBeInTheDocument()
  })

  it("is the chat's tab name for a chat sender open here, as its tab shows it", () => {
    conversationNames.set(SESSION, 'Port the parser')
    useAppStore.setState({ unifiedTabsByWorktree: { [WORKTREE]: [chatTab()] } })
    renderSenders(
      source({
        address: `orca_session_id:${SESSION}`,
        terminalHandle: null,
        orcaSessionId: SESSION
      })
    )
    expect(screen.getByRole('button', { name: 'Port the parser' })).toBeInTheDocument()
  })

  it('keeps the recorded name for a chat sender whose tab has no name of its own', () => {
    useAppStore.setState({ unifiedTabsByWorktree: { [WORKTREE]: [chatTab()] } })
    renderSenders(
      source(
        { address: `orca_session_id:${SESSION}`, terminalHandle: null, orcaSessionId: SESSION },
        'Port the parser task'
      )
    )
    expect(screen.getByRole('button', { name: 'Port the parser task' })).toBeInTheDocument()
  })

  it('keeps the recorded name when its agent row has no name of its own', () => {
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE]: [terminalTab({ title: 'Claude Code' })] },
      agentStatusByPaneKey: { [`${TAB}:${LEAF}`]: agentRow(HANDLE) }
    })
    renderSenders(source({}))
    expect(screen.getByRole('button', { name: 'Recorded name' })).toBeInTheDocument()
  })

  it('keeps the recorded name once the sender is gone from this window', () => {
    renderSenders(source({}))
    expect(screen.getByRole('button', { name: 'Recorded name' })).toBeInTheDocument()
  })

  it('keeps the recorded name for a sender on another host, whatever runs here', () => {
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE]: [terminalTab({ customTitle: 'Local agent' })] },
      agentStatusByPaneKey: { [`${TAB}:${LEAF}`]: agentRow(HANDLE) }
    })
    renderSenders(source({ address: 'dispatch:d1' }, 'Remote task'))
    expect(screen.getByText('Remote task')).toBeInTheDocument()
    expect(screen.queryByText('Local agent')).not.toBeInTheDocument()
  })
})

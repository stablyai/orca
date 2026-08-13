// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentChatPanel } from './AgentChatPanel'

const nativeChatConversation = vi.hoisted(() => vi.fn())
vi.mock('@/components/native-chat/NativeChatConversation', () => ({
  NativeChatConversation: (props: Record<string, unknown>) => {
    nativeChatConversation(props)
    return <div data-testid="native-chat-conversation" />
  }
}))

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Ship the chat panel',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'chat-panel',
    conversationName: 'Chat agent',
    hostKind: 'local',
    sessionId: 'session-1',
    transcriptPath: '/tmp/session-1.jsonl',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentChatPanel', () => {
  it('routes a live card through the established native conversation surface', () => {
    const onOpenTerminal = vi.fn()
    const ptyWriter = { write: vi.fn(() => true), writeAccepted: vi.fn(async () => true) }
    render(
      <AgentChatPanel
        card={card({ lastAgentMessage: 'Still working' })}
        onClose={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        ptyWriter={ptyWriter}
      />
    )

    expect(nativeChatConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: 'tab-1:leaf-1',
        agent: 'claude',
        sessionId: 'session-1',
        transcriptPath: '/tmp/session-1.jsonl',
        targetPtyId: 'pty-1',
        terminalTabId: 'tab-1',
        onSwitchToTerminal: onOpenTerminal,
        ptyWriter,
        attachmentOwner: { kind: 'local' },
        dictationEnabled: false,
        sessionOptionsEnabled: false,
        fileDropEnabled: false,
        fileLinksEnabled: false,
        liveState: expect.objectContaining({
          working: true,
          stateStartedAt: 1,
          lastAssistantMessage: 'Still working'
        })
      })
    )
    expect(screen.getByTestId('native-chat-conversation')).toBeInTheDocument()
    const conversationProps = nativeChatConversation.mock.calls[0]?.[0]
    expect(conversationProps).not.toHaveProperty('contextMenuActions')
    expect(conversationProps).not.toHaveProperty('fileLinkContext')
    expect(screen.getByRole('heading', { name: 'Chat agent' })).toBeInTheDocument()
    expect(screen.getByText('Orca / chat-panel')).toBeInTheDocument()
  })

  it('passes a guarded Claude question baseline to the shared interactive card', () => {
    render(
      <AgentChatPanel
        card={card({
          bucket: 'attention',
          dotState: 'waiting',
          lastUserMessage: 'Choose a database',
          askSummary: '{"questions":[]}',
          interactiveToolName: 'AskUserQuestion',
          statusUpdatedAt: 20,
          stateChangedAt: 10
        })}
        onClose={vi.fn()}
      />
    )

    expect(nativeChatConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        liveState: expect.objectContaining({
          working: false,
          interactivePrompt: '{"questions":[]}',
          interactiveToolName: 'AskUserQuestion',
          questionInferenceRequest: {
            paneKey: 'tab-1:leaf-1',
            baselineUpdatedAt: 20,
            baselineStateStartedAt: 10,
            baselinePrompt: 'Choose a database',
            baselineAgentType: 'claude'
          }
        })
      })
    )
  })

  it('shows acknowledged completions with the dashboard idle state', () => {
    render(
      <AgentChatPanel
        card={card({ bucket: 'idle', dotState: 'done', unseen: false })}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Idle')).toBeInTheDocument()
    expect(screen.queryByLabelText('Done')).not.toBeInTheDocument()
  })

  it('lets the shared composer guard a missing live pane', () => {
    render(<AgentChatPanel card={card({ ptyId: null })} onClose={vi.fn()} />)

    expect(nativeChatConversation).toHaveBeenCalledWith(
      expect.objectContaining({ targetPtyId: null })
    )
  })

  it('degrades to snapshot text when the card has no session', () => {
    render(
      <AgentChatPanel
        card={card({
          sessionId: undefined,
          transcriptPath: undefined,
          bucket: 'attention',
          dotState: 'waiting',
          askSummary: 'Approve the migration?',
          lastAgentMessage: 'I paused before the migration.'
        })}
        onClose={vi.fn()}
      />
    )

    expect(nativeChatConversation).not.toHaveBeenCalled()
    expect(screen.getByText(/has not reported a session yet/)).toBeInTheDocument()
    expect(screen.getByText('Approve the migration?')).toBeInTheDocument()
    expect(screen.getByText('I paused before the migration.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Reply to this agent')).not.toBeInTheDocument()
  })

  it.each(['ssh', 'wsl', 'remote'] as const)(
    'degrades on a %s host instead of mounting a local conversation',
    (hostKind) => {
      render(<AgentChatPanel card={card({ hostKind })} onClose={vi.fn()} />)

      expect(nativeChatConversation).not.toHaveBeenCalled()
      expect(screen.getByText(/transcript is on another host/)).toBeInTheDocument()
    }
  )

  it('escalates to the terminal and closes on request', () => {
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn()
    render(<AgentChatPanel card={card()} onClose={onClose} onOpenTerminal={onOpenTerminal} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

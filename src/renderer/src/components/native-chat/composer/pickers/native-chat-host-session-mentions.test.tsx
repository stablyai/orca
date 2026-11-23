import { describe, expect, it } from 'vitest'
import type { AgentConversationRow } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalSummary } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { hostSessionMentions } from './native-chat-host-session-mentions'

const chat = (
  orcaSessionId: string,
  paneKey: string,
  worktreeId = 'worktree:app'
): AgentConversationRow => ({
  orcaSessionId,
  kind: 'chat',
  agent: 'claude',
  state: 'idle',
  worktreeId,
  workspace: 'app',
  paneKey,
  title: orcaSessionId,
  lastAssistantMessage: null,
  updatedAt: 0
})

const terminal = (handle: string, ptyId: string, orphaned = false): RuntimeTerminalSummary => ({
  handle,
  ptyId,
  orphaned,
  worktreeId: 'worktree:app',
  worktreePath: '/app',
  branch: 'main',
  tabId: `tab-${handle}`,
  leafId: 'leaf',
  title: handle,
  connected: true,
  writable: true,
  lastOutputAt: null,
  preview: ''
})

describe('hostSessionMentions', () => {
  it('lists each other chat and terminal once, never the composer, crew agents or bot chats', () => {
    const mentions = hostSessionMentions(
      {
        hostKey: 'env-1',
        agents: [
          // The composer's own chat after a /clear: a new running pane, the old root ID.
          chat('root', 'own-pane'),
          chat('other', 'pane-a'),
          chat('other', 'pane-b'),
          chat('crew-chat', 'pane-c'),
          chat('bot-chat', 'pane-d', 'folder:bot-home'),
          { ...chat('terminal-agent', 'pane-e'), kind: 'terminal' }
        ],
        terminals: [
          terminal('term_own', 'pty-own'),
          terminal('term_crew', 'pty-crew'),
          terminal('term_gone', 'pty-gone', true),
          terminal('term_dev', 'pty-dev')
        ],
        isBotHome: (worktreeId) => worktreeId === 'folder:bot-home'
      },
      { paneKey: 'own-pane', sessionId: 'running', ptyId: 'remote:env-1@@term_own' },
      new Set(['orca_session_id:crew-chat', 'term_crew'])
    )

    expect([...mentions.chats, ...mentions.terminals].map((row) => row.key)).toEqual([
      'host-chat:other',
      'host-terminal:term_dev'
    ])
    expect([...mentions.references.values()]).toEqual([
      {
        label: 'other',
        address: 'orca_session_id:other',
        hostKey: 'env-1',
        kind: 'chat',
        agentType: 'claude'
      },
      { label: 'term_dev', address: 'term_dev', hostKey: 'env-1', kind: 'terminal' }
    ])
  })
})

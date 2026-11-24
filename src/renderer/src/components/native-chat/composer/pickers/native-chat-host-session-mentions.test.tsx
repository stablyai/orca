import { describe, expect, it } from 'vitest'
import type { AgentConversationRow } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import type { RuntimeTerminalSummary } from '../../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrchestrationCrewSnapshot } from '../../../../../../shared/orchestration/orchestration-crew'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { crewAgentMentions } from '../../../orchestration-crew/native-chat-crew-mentions'
import { hostSessionMentions, type HostSessionLists } from './native-chat-host-session-mentions'

// A chat's pane: its tab, and the session that runs there now.
const pane = (tab: string, running: string) => structuredAgentSessionPaneKey(tab, running)

const chat = (
  orcaSessionId: string,
  paneKey: string,
  worktreeId = 'worktree:app'
): AgentConversationRow => ({
  orcaSessionId,
  kind: 'chat',
  agent: 'claude',
  state: 'done',
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

const lists = (
  agents: AgentConversationRow[],
  terminals: RuntimeTerminalSummary[]
): HostSessionLists => ({
  hostKey: 'env-1',
  agents,
  terminals,
  isBotHome: (worktreeId) => worktreeId === 'folder:bot-home'
})

const keys = (mentions: ReturnType<typeof hostSessionMentions>) =>
  [...mentions.chats, ...mentions.terminals].map((row) => row.key)

describe('hostSessionMentions', () => {
  it('lists each other chat and terminal once, never the composer, bot chats or orphans', () => {
    const ownPane = pane('tab-own', 'running')
    const mentions = hostSessionMentions(
      lists(
        [
          // The composer's own chat after a /clear: its listed root ID is not its running ID.
          chat('root', ownPane),
          chat('root', pane('tab-split', 'root')),
          chat('running', pane('tab-old', 'old')),
          chat('other', pane('tab-a', 'other')),
          chat('other', pane('tab-b', 'other')),
          chat('bot-chat', pane('tab-bot', 'bot-chat'), 'folder:bot-home'),
          { ...chat('terminal-agent', 'pane-e'), kind: 'terminal' }
        ],
        [
          terminal('term_own', 'pty-own'),
          terminal('term_gone', 'pty-gone', true),
          terminal('term_dev', 'pty-dev')
        ]
      ),
      { paneKey: ownPane, sessionId: 'running', ptyId: 'remote:env-1@@term_own' },
      new Set()
    )

    expect(keys(mentions)).toEqual(['host-chat:other', 'host-terminal:term_dev'])
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

  it('leaves out the own chat in every pane and the own local terminal by pane and PTY alone', () => {
    const ownPane = pane('tab-own', 'running')
    const mentions = hostSessionMentions(
      lists(
        [chat('root', ownPane), chat('root', pane('tab-split', 'root'))],
        [terminal('term_own', 'pty-own'), terminal('term_dev', 'pty-dev')]
      ),
      { paneKey: ownPane, ptyId: 'pty-own' },
      new Set()
    )

    expect(keys(mentions)).toEqual(['host-terminal:term_dev'])
  })

  it("leaves out the crew's chats and terminals, also when mail reaches them by dispatch", () => {
    const crew = crewAgentMentions(
      {
        status: 'ok',
        sections: {
          managedBy: [],
          managing: [
            {
              partyKey: 'w-chat',
              role: 'worker',
              label: 'auth-tests',
              agentKind: 'claude',
              status: 'working',
              sendAddress: 'dispatch:d1',
              openTarget: { kind: 'chat', sessionId: 'worker-running', worktreeId: 'worktree:app' }
            },
            {
              partyKey: 'w-term',
              role: 'worker',
              label: 'perf',
              agentKind: 'codex',
              status: 'working',
              sendAddress: 'dispatch:d2',
              openTarget: { kind: 'terminal', handle: 'term_worker' }
            }
          ],
          talkingWith: []
        }
      } as OrchestrationCrewSnapshot,
      'env-1'
    )
    const mentions = hostSessionMentions(
      lists(
        [
          chat('worker-root', pane('tab-w', 'worker-running')),
          // A second pane of the crew chat, which still names its root session.
          chat('worker-root', pane('tab-split', 'worker-root')),
          chat('other', pane('tab-a', 'other'))
        ],
        [terminal('term_worker', 'pty-worker'), terminal('term_dev', 'pty-dev')]
      ),
      { paneKey: 'pane-own', ptyId: null },
      crew.addresses
    )

    expect([...crew.mentions.map((row) => row.key), ...keys(mentions)]).toEqual([
      'crew-agent:w-chat',
      'crew-agent:w-term',
      'host-chat:other',
      'host-terminal:term_dev'
    ])
  })

  it("gives a terminal chip its agent's Orca session ID when the terminal runs a named agent", () => {
    const mentions = hostSessionMentions(
      lists(
        [
          // A terminal agent's pane key is its terminal's tab and leaf.
          { ...chat('codex-session', 'tab-term_codex:leaf'), kind: 'terminal' },
          { ...chat('', 'tab-term_unnamed:leaf'), orcaSessionId: null, kind: 'terminal' }
        ],
        [
          terminal('term_codex', 'pty-codex'),
          terminal('term_unnamed', 'pty-unnamed'),
          terminal('term_dev', 'pty-dev')
        ]
      ),
      { paneKey: 'pane-own', ptyId: null },
      new Set()
    )

    expect(
      [...mentions.references.values()].map(({ address, session }) => [address, session])
    ).toEqual([
      ['term_codex', 'orca_session_id:codex-session'],
      ['term_unnamed', undefined],
      ['term_dev', undefined]
    ])
  })
})

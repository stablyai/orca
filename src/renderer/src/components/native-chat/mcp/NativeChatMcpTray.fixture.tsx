import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentSessionMcpServer } from '../../../../../shared/agent-session/options/protocol/agent-session-mcp'
import type { AgentSessionMcpPanelState } from '../../../../../shared/agent-session/view/use-agent-session-mcp-panel'
import { NativeChatThreadGoalBanner } from '../session/goals/NativeChatThreadGoalBanner'
import { NativeChatMcpTrayView } from './NativeChatMcpTray'

function server(
  name: string,
  status: AgentSessionMcpServer['status'],
  fields: Partial<AgentSessionMcpServer> = {}
): AgentSessionMcpServer {
  return {
    name,
    status,
    source: null,
    toolCount: null,
    error: null,
    canSignIn: false,
    canReconnect: false,
    canToggle: true,
    ...fields
  }
}

const CLAUDE_SERVERS: AgentSessionMcpServer[] = [
  server('e2e-probe', 'needs-auth', { source: 'project', canSignIn: true }),
  server('postgres', 'failed', {
    source: 'project',
    error: 'connection refused',
    canReconnect: true
  }),
  server('claude.ai Linear', 'connected', { source: 'claudeai', toolCount: 70 }),
  server('claude.ai Notion', 'connected', { source: 'claudeai', toolCount: 77 }),
  server('claude.ai Gmail', 'needs-auth', { source: 'claudeai', canSignIn: true }),
  server('claude.ai Mobbin', 'disabled', { source: 'claudeai' }),
  server('claude-artifacts', 'pending', { source: 'dynamic' })
]

const SIGN_IN_SERVERS: AgentSessionMcpServer[] = [
  server('e2e-probe', 'needs-auth', { source: 'project', canSignIn: true }),
  server('postgres', 'failed', {
    source: 'project',
    error: 'connection refused',
    canReconnect: true
  }),
  server('claude.ai Linear', 'connected', { source: 'claudeai', toolCount: 70 })
]

const GOAL = {
  objective: 'Ship the settings page with tests',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 754,
  createdAt: 0,
  updatedAt: 0
} as const

// The composer box is mocked, as the worker lifetime fixture does.
function fixture(
  state: Partial<AgentSessionMcpPanelState>,
  options: { runtime?: 'local' | 'remote'; underGoal?: boolean } = {}
) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        {options.underGoal ? (
          <NativeChatThreadGoalBanner
            goal={GOAL}
            pending={false}
            hostChanges
            sendUnavailable={false}
            isVisible={false}
            runningTurn={null}
            onChange={() => {}}
          />
        ) : null}
        <NativeChatMcpTrayView
          state={{
            result: { status: 'ok' },
            servers: [],
            pending: null,
            signIn: null,
            failure: null,
            ...state
          }}
          runtime={options.runtime ?? 'local'}
          run={() => {}}
          retry={() => {}}
          retrying={false}
          dismissSignIn={() => {}}
          openUrl={() => {}}
          onClose={() => {}}
        />
        <div className="px-3 pt-2 sm:px-4">
          <div className="mx-auto h-20 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            Ask anything, @ to mention files, / for commands
          </div>
        </div>
      </div>
    )
  })
}

export const groupedList = fixture({ servers: CLAUDE_SERVERS })

export const localSignIn = fixture({
  servers: SIGN_IN_SERVERS,
  signIn: { server: 'e2e-probe', url: 'https://example.com/oauth', finish: 'callback' }
})

export const remoteSignIn = fixture(
  {
    servers: SIGN_IN_SERVERS,
    signIn: { server: 'e2e-probe', url: 'https://example.com/oauth', finish: 'callback' }
  },
  { runtime: 'remote' }
)

export const claudeAiSignIn = fixture({
  servers: [
    server('claude.ai Gmail', 'needs-auth', { source: 'claudeai', canSignIn: true }),
    server('claude.ai Linear', 'connected', { source: 'claudeai', toolCount: 70 })
  ],
  signIn: { server: 'claude.ai Gmail', url: 'https://claude.ai/connectors', finish: 'external' },
  failure: { server: 'claude.ai Gmail', message: null }
})

export const rowFailure = fixture({
  servers: CLAUDE_SERVERS,
  failure: { server: 'postgres', message: 'Server is still starting' }
})

export const notRunning = fixture({ result: { status: 'not-running' } })

export const readFailed = fixture({ result: { status: 'failed', message: null } })

export const underGoal = fixture({ servers: SIGN_IN_SERVERS }, { underGoal: true })

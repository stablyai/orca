import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentSessionMcpServer } from '../../../../../shared/agent-session/agent-session-mcp'
import type { AgentSessionMcpPanelState } from '../../../../../shared/agent-session/view/use-agent-session-mcp-panel'
import { NativeChatMcpServersDialogView } from './NativeChatMcpServersDialog'

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
  server('Linear', 'connected', { source: 'claudeai', toolCount: 24 }),
  server('Slack', 'needs-auth', { source: 'claudeai', canSignIn: true }),
  server('postgres', 'failed', {
    source: 'project',
    error: 'connection refused',
    canReconnect: true
  }),
  server('playwright', 'disabled', { source: 'project' }),
  server('github', 'pending', { source: 'user' })
]

const SLACK_ONLY = [server('Slack', 'needs-auth', { source: 'claudeai', canSignIn: true })]

function fixture(state: Partial<AgentSessionMcpPanelState>, runtime: 'local' | 'remote' = 'local') {
  return defineFixture({
    render: () => (
      <NativeChatMcpServersDialogView
        state={{
          result: { status: 'ok' },
          servers: [],
          pending: null,
          signIn: null,
          failure: null,
          ...state
        }}
        runtime={runtime}
        run={() => {}}
        retry={() => {}}
        retrying={false}
        dismissSignIn={() => {}}
        openUrl={() => {}}
        onClose={() => {}}
      />
    )
  })
}

export const groupedList = fixture({ servers: CLAUDE_SERVERS })

export const codexList = fixture({
  servers: [
    server('context7', 'connected', { toolCount: 2 }),
    server('notion', 'needs-auth', { canSignIn: true }),
    server('sentry', 'disabled')
  ]
})

export const localCallbackSignIn = fixture({
  servers: SLACK_ONLY,
  signIn: { server: 'Slack', url: 'https://slack.com/oauth', finish: 'callback' }
})

export const remoteCallbackSignIn = fixture(
  {
    servers: SLACK_ONLY,
    signIn: { server: 'Slack', url: 'https://slack.com/oauth', finish: 'callback' }
  },
  'remote'
)

export const externalSignIn = fixture({
  servers: SLACK_ONLY,
  signIn: { server: 'Slack', url: 'https://claude.ai/connectors', finish: 'external' }
})

export const rowFailure = fixture({
  servers: CLAUDE_SERVERS,
  failure: { server: 'postgres', message: null }
})

export const notRunning = fixture({ result: { status: 'not-running' } })

export const readFailed = fixture({ result: { status: 'failed', message: null } })

export const empty = fixture({})

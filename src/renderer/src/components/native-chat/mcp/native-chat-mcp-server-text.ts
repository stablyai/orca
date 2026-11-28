import type {
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../../../../../shared/agent-session/options/protocol/agent-session-mcp'
import {
  agentSessionMcpServerDisplayName,
  agentSessionMcpShownStatus,
  ORCA_MCP_SOURCE
} from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
import { urlHost } from '@/components/settings/mcp-servers/mcp-server-words'
import type { Translate } from '@/i18n/use-translate'

export function mcpSourceLabel(source: string, t: Translate): string {
  switch (source) {
    case 'orca':
      return 'Orca'
    case 'claudeai':
      return 'claude.ai'
    case 'project':
      return t('components.native-chat.mcp.source.project', 'Project')
    case 'local':
      return t('components.native-chat.mcp.source.local', 'Local')
    case 'user':
      return t('components.native-chat.mcp.source.user', 'User')
    case 'dynamic':
      return t('components.native-chat.mcp.source.session', 'Session')
    case 'plugin':
      return t('components.native-chat.mcp.source.plugin', 'Plugin')
    default:
      return source.charAt(0).toUpperCase() + source.slice(1)
  }
}

/** The row's dot already says connected, so a connected server shows its tools. `hostName`: the
 *  chat's host, which a command of Orca's that won't start is missing from. */
export function mcpServerStatusLine(
  server: AgentSessionMcpServer,
  t: Translate,
  hostName?: string
): string {
  // The chat keeps its launch copy of a server Orca changed until the next message restarts it.
  if (server.orcaChange === 'removed') {
    return t('components.native-chat.mcp.status.orcaRemoved', 'Removed: restarts on next message')
  }
  if (server.orcaChange === 'changed' && server.status !== 'connected') {
    return t('components.native-chat.mcp.status.orcaChanged', 'Changed: restarts on next message')
  }
  switch (server.status) {
    case 'connected':
      return server.toolCount === null
        ? t('components.native-chat.mcp.status.connected', 'Connected')
        : t('components.native-chat.mcp.status.tools', '{{count}} tools', {
            count: server.toolCount,
            defaultValue_one: '{{count}} tool'
          })
    case 'pending':
      return t('components.native-chat.mcp.status.pending', 'Connecting…')
    case 'needs-auth':
      // Orca signs in to its own servers, from its MCP servers page.
      return server.canSignIn || server.source === ORCA_MCP_SOURCE
        ? t('components.native-chat.mcp.status.needsAuth', 'Needs sign-in')
        : t(
            'components.native-chat.mcp.status.needsAuthAfterSend',
            'Needs sign-in. Send a message to sign in here.'
          )
    case 'failed':
      // Orca's own check found it before the agent started, in the words its settings use.
      if (server.orca && !server.error) {
        return server.orca.url !== null
          ? t('settings.mcpServers.status.unreachable', 'Can’t reach {{host}}', {
              host: urlHost(server.orca.url)
            })
          : hostName
            ? t('settings.mcpServers.status.commandFailed', 'Command not found on {{host}}', {
                host: hostName
              })
            : t('components.native-chat.mcp.status.failed', 'Failed')
      }
      return server.error
        ? t('components.native-chat.mcp.status.failedReason', 'Failed: {{error}}', {
            error: server.error
          })
        : t('components.native-chat.mcp.status.failed', 'Failed')
    case 'disabled':
      return t('components.native-chat.mcp.status.disabled', 'Disabled')
    case 'not-started':
      return t('components.native-chat.mcp.status.notStarted', 'Not started')
    case 'unreported':
      return ''
  }
}

export type McpTraySummaryPart = { text: string; tone: 'muted' | 'warning' }

/** The tray header's counts, only those above zero; a sign-in in progress replaces them. */
export function mcpTraySummary(
  servers: readonly AgentSessionMcpServer[],
  signIn: AgentSessionMcpSignIn | null,
  t: Translate
): McpTraySummaryPart[] {
  if (signIn) {
    const server = servers.find((entry) => entry.name === signIn.server)
    const name = server ? agentSessionMcpServerDisplayName(server) : signIn.server
    return [
      {
        text: t('components.native-chat.mcp.summary.signingIn', 'signing in to {{name}}', { name }),
        tone: 'muted'
      }
    ]
  }
  const count = (status: AgentSessionMcpServer['status']): number =>
    servers.filter((server) => agentSessionMcpShownStatus(server) === status).length
  const connected = count('connected')
  const needsAuth = count('needs-auth')
  const failed = count('failed')
  const parts: McpTraySummaryPart[] = []
  if (connected > 0) {
    parts.push({
      text: t('components.native-chat.mcp.summary.connected', '{{count}} connected', {
        count: connected
      }),
      tone: 'muted'
    })
  }
  if (needsAuth > 0) {
    parts.push({
      text: t('components.native-chat.mcp.summary.needsAuth', '{{count}} need sign-in', {
        count: needsAuth,
        defaultValue_one: '{{count}} needs sign-in'
      }),
      tone: 'warning'
    })
  }
  if (failed > 0) {
    parts.push({
      text: t('components.native-chat.mcp.summary.failed', '{{count}} failed', { count: failed }),
      tone: 'muted'
    })
  }
  return parts
}

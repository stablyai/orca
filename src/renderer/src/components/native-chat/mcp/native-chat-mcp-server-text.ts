import type { AgentSessionMcpServer } from '../../../../../shared/agent-session/agent-session-mcp'
import type { Translate } from '@/i18n/use-translate'

export function mcpSourceLabel(source: string, t: Translate): string {
  switch (source) {
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

export function mcpServerStatusLine(server: AgentSessionMcpServer, t: Translate): string {
  switch (server.status) {
    case 'connected':
      return server.toolCount === null
        ? t('components.native-chat.mcp.status.connected', 'Connected')
        : t('components.native-chat.mcp.status.connectedTools', 'Connected · {{count}} tools', {
            count: server.toolCount,
            defaultValue_one: 'Connected · {{count}} tool'
          })
    case 'pending':
      return t('components.native-chat.mcp.status.pending', 'Connecting…')
    case 'needs-auth':
      return server.canSignIn
        ? t('components.native-chat.mcp.status.needsAuth', 'Needs sign-in')
        : t(
            'components.native-chat.mcp.status.needsAuthAfterSend',
            'Needs sign-in. Send a message to sign in here.'
          )
    case 'failed':
      return server.error
        ? t('components.native-chat.mcp.status.failedReason', 'Failed: {{error}}', {
            error: server.error
          })
        : t('components.native-chat.mcp.status.failed', 'Failed')
    case 'disabled':
      return t('components.native-chat.mcp.status.disabled', 'Disabled')
  }
}

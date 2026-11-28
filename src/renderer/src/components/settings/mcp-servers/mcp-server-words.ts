// What a server's row and page say: its title, its line, its status, and who it's on for.
import type { Translate } from '@/i18n/use-translate'
import type { BotToolProblem } from '../../../../../shared/bot-tools'
import { botToolSignInUnreadable } from '../../../../../shared/bot-tool-sign-in'
import type { McpAgentProblem, McpServer } from '../../../../../shared/mcp-servers/mcp-servers'
import { MCP_SERVER_CATALOG } from '../../../../../shared/mcp-servers/mcp-server-catalog'
import { botToolTitle } from '../../../../../shared/bots/bot-tool-labels'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { McpWorkspacesSummary } from './mcp-server-workspace-choice'

/** linear → Linear (the catalog's own name), my-tool → My tool. */
export function mcpServerTitle(name: string): string {
  return MCP_SERVER_CATALOG.find((entry) => entry.id === name)?.name ?? botToolTitle(name)
}

/** The address without its scheme, or the command line. */
export function mcpServerLine(server: Pick<McpServer, 'detail' | 'transport'>): string {
  return server.transport === 'http' ? server.detail.replace(/^https?:\/\//i, '') : server.detail
}

/** A server address's host, for "Can’t reach …". */
export function urlHost(detail: string): string {
  try {
    return new URL(detail).host
  } catch {
    return detail
  }
}

export type McpRowStatus = {
  label: string
  /** success: no dot; attention: amber; failed: red. */
  tone: 'success' | 'attention' | 'failed'
  /** A failure says it all: the row shows it in place of the server's line. */
  replacesLine: boolean
}

/** Orca's own sign-in that the user must (re)do: the row offers Sign in. */
export function mcpServerNeedsSignIn(server: McpServer): boolean {
  return server.signIn !== undefined && server.signIn.state !== 'signed-in'
}

export function mcpServerUnreadable(server: McpServer): boolean {
  return botToolSignInUnreadable(server.signIn)
}

export function mcpServerStatus(
  server: McpServer,
  problem: BotToolProblem | undefined,
  hostName: string,
  t: Translate
): McpRowStatus | null {
  if (mcpServerUnreadable(server)) {
    return {
      label: t('settings.mcpServers.signInAgain', 'Sign in again'),
      tone: 'attention',
      replacesLine: false
    }
  }
  if (mcpServerNeedsSignIn(server) || (!server.signIn && problem?.kind === 'sign-in')) {
    return {
      label: t('settings.mcpServers.status.needsSignIn', 'Needs sign-in'),
      tone: 'attention',
      replacesLine: false
    }
  }
  if (problem?.kind === 'failed') {
    return {
      label:
        server.transport === 'command'
          ? t('settings.mcpServers.status.commandFailed', 'Command not found on {{host}}', {
              host: hostName
            })
          : t('settings.mcpServers.status.unreachable', 'Can’t reach {{host}}', {
              host: urlHost(server.detail)
            }),
      tone: 'failed',
      replacesLine: true
    }
  }
  if (server.signIn?.state === 'signed-in') {
    return {
      label: t('settings.mcpServers.status.signedIn', 'Signed in'),
      tone: 'success',
      replacesLine: false
    }
  }
  return null
}

/** "All agents", "6 of 9 agents", "No agents"; just the off ones counted while the host lists its agents. */
export function mcpAgentsSummary(
  server: McpServer,
  agents: readonly string[] | null,
  t: Translate
): string {
  const total = agents?.length ?? null
  const on =
    agents === null ? null : agents.filter((agent) => !server.agentsOff.includes(agent)).length
  if (on === null || total === null) {
    // Until the host lists its agents, only the ones turned off are known.
    return server.agentsOff.length === 0
      ? t('settings.mcpServers.agents.all', 'All agents')
      : t('settings.mcpServers.agents.someOff', '{{count}} agents off', {
          count: server.agentsOff.length
        })
  }
  if (on === total) {
    return t('settings.mcpServers.agents.all', 'All agents')
  }
  return on === 0
    ? t('settings.mcpServers.agents.none', 'No agents')
    : t('settings.mcpServers.agents.some', '{{on}} of {{total}} agents', { on, total })
}

export function mcpWorkspacesSummaryText(summary: McpWorkspacesSummary, t: Translate): string {
  switch (summary.kind) {
    case 'all':
      return t('settings.mcpServers.workspaces.all', 'All workspaces')
    case 'none':
      return t('settings.mcpServers.workspaces.none', 'No workspaces')
    case 'all-but':
      return t('settings.mcpServers.workspaces.allBut', 'All but {{names}}', {
        names: summary.names.join(', ')
      })
    case 'only':
      return t('settings.mcpServers.workspaces.only', 'Only {{names}}', {
        names: summary.names.join(', ')
      })
  }
}

/** An agent row's problem line: a blocked Claude line in the UI language; anything else in the host's words. */
export function mcpAgentProblemText(agent: string, problem: McpAgentProblem, t: Translate): string {
  return problem.kind === 'blocked' && agent === 'claude'
    ? t('settings.mcpServers.agents.blocked', 'Blocked by your organization’s Claude settings')
    : problem.detail
}

/** An agent as the host names it: Orca's label for one it knows, else the host's id. */
export function mcpAgentLabel(agent: string): string {
  return isTuiAgent(agent) ? getAgentLabel(agent) : agent
}

/** "Claude Code, Codex and Gemini CLI". */
export function mcpAgentNames(agents: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(agents.map(mcpAgentLabel))
}

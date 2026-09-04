import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat-session-option-state'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'
import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'

export function readReportedSessionOptionsFromTerminalScreen(
  agent: AgentType,
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): Record<string, SessionOptionValue> | null {
  if (agent === 'claude') {
    return readClaudeSessionOptionsFromTerminalScreen(screen, models)
  }
  if (agent === 'codex') {
    return readCodexSessionOptionsFromTerminalScreen(screen, models)
  }
  return null
}

export function reportedNativeChatModelValues(
  agent: AgentType,
  reportedModel: string | null | undefined
): Record<string, SessionOptionValue> | null {
  const trimmed = reportedModel?.trim()
  if (!trimmed) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return null
  }
  return { model: matchNativeChatCatalogModelId(catalog, trimmed) ?? trimmed }
}

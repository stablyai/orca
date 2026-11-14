import { getAgentRowConversationName } from '../../../../../shared/agent-status/presentation/agent-row-conversation-name'
import { DASHBOARD_MAX_LABEL_LENGTH } from '../../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolveAgentRowPaneLiveTitle } from '../rows/agent-row-pane-live-title'
import { structuredChatTabById } from '@/lib/agent-session/tab-identity/structured-chat-tab-index'
import { projectedStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { DashboardAgentRow } from '../rows/dashboard-agent-row'
import type { AppState } from '@/store/types'

export function rowTask(row: DashboardAgentRow): string {
  return (row.entry.orchestration?.taskTitle ?? '').trim() || (row.entry.prompt ?? '').trim()
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Bound untrusted terminal names and titles before snapshot validation can drop their cards. */
export function boundedLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

export function boundedLabelOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedLabel(value)
}

/** Match useAgentRowConversationName so sidebar and board name the same agent identically. */
export function rowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean,
  layout: TerminalLayoutSnapshot | undefined,
  paneTitles: Record<number, string> | undefined,
  names: StructuredChatTabNames,
  tabs: AppState['unifiedTabsByWorktree'] | undefined
): string | undefined {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  // Why: a child row rendered on its parent's tab does not own that tab's name.
  if (
    row.rowSource === 'subagent' ||
    (row.lineage?.depth === 1 &&
      parentPaneKey !== undefined &&
      parsePaneKey(parentPaneKey)?.tabId === row.tab.id)
  ) {
    return undefined
  }
  const chat = structuredChatTabById(tabs, row.tab.worktreeId, row.tab.id)
  if (chat) {
    return projectedStructuredChatTabName(chat, names)
  }
  const paneLiveTitle = resolveAgentRowPaneLiveTitle(
    layout,
    paneTitles,
    parsePaneKey(row.paneKey)?.leafId
  )
  return (
    getAgentRowConversationName(
      row.tab,
      row.agentType,
      generatedTitlesEnabled,
      paneLiveTitle,
      row.entry.providerSession?.id
    ) ?? undefined
  )
}

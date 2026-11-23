import type { AppState } from '@/store/types'
import type { StructuredSubjectRead } from '@/attention/agent-subject-read-actions'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import {
  findTabByIdOrChatAlias,
  isStructuredTab,
  structuredAgentSessionIdOfTab,
  structuredAgentSessionStatusPaneKey
} from '../../../../shared/agent-session/view/structured-agent-session-tab'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { toHostSessionPaneKey } from '../../../../shared/workspace-layout/terminal-surface-id'

export function notchPaneKeyForSubject(
  state: AppState,
  subjectKey: string,
  structured?: Pick<StructuredSubjectRead, 'sessionId' | 'target'>
): string | null {
  if (structured) {
    const key = structuredAgentSessionStatusPaneKey(structured.sessionId)
    return structured.target.kind === 'environment'
      ? `${toRuntimeExecutionHostId(structured.target.environmentId)}|${key}`
      : key
  }
  const pane = parsePaneKey(subjectKey)
  const source = pane
    ? state.agentStatusByPaneKey.projection.mobileSource(subjectKey, pane.tabId)
    : undefined
  const worktreeId = source?.worktreeId ?? state.agentStatusByPaneKey.get(subjectKey)?.worktreeId
  if (!worktreeId) {
    return null
  }
  const tab = pane
    ? findTabByIdOrChatAlias(state.unifiedTabsByWorktree[worktreeId], pane.tabId)
    : undefined
  if (tab && isStructuredTab(tab)) {
    const target = structuredAgentSessionTargetForTab(state, tab)
    return target
      ? notchPaneKeyForSubject(state, subjectKey, { sessionId: tab.entityId, target })
      : null
  }
  if (tab?.contentType === 'agent-session' || (pane && structuredAgentSessionIdOfTab(pane.tabId))) {
    return null
  }
  const owner = resolveTerminalNotificationOwner(state, worktreeId, { paneKey: subjectKey })
  if (!owner) {
    return null
  }
  const host = parseExecutionHostId(owner.executionHostId)
  const environmentId =
    owner.runtimeEnvironmentId ?? (host?.kind === 'runtime' ? host.environmentId : null)
  if (!environmentId && (!host || host.kind === 'runtime')) {
    return null
  }
  const key = toHostSessionPaneKey(subjectKey)
  return environmentId ? `${toRuntimeExecutionHostId(environmentId)}|${key}` : key
}

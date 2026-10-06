import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session-chat-label'

export function session(
  host: ExecutionHostId = 'local',
  agent: 'codex' | 'claude' = 'codex'
): AiVaultSession {
  return {
    id: `${host}:provider-session`,
    executionHostId: host,
    agent,
    sessionId: 'provider-session',
    title: defaultAgentChatLabel(agent),
    cwd: '/folder',
    branch: null,
    model: null,
    filePath: '/sessions/provider-session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-06T00:00:00Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume provider-session',
    subagent: null,
    structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-session' }
  }
}

export function tab(
  label = 'Codex Chat',
  host: ExecutionHostId = 'local',
  agent: 'codex' | 'claude' = 'codex'
): Tab {
  return {
    id: 'native-tab',
    entityId: 'native-session',
    groupId: 'group',
    worktreeId: 'folder-workspace',
    executionHostId: host,
    contentType: 'agent-session',
    agentSessionAgent: agent,
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function result(row: AiVaultSession = session()): AiVaultListResult {
  return { sessions: [row], issues: [], scannedAt: '2026-10-06T00:00:00Z' }
}

import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session/agent-session-wire'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../../shared/agent-session/structured-agent-session-create'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-create-capabilities'
import { createBrowserUuid } from './browser-uuid'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  callStructuredAgentSession,
  structuredAgentSessionHostSupports
} from '@/runtime/structured-agent-session-client'

/** An empty chat is published by its execution host; transport errors never trigger another create. */
export async function launchCustomAgentChat(input: {
  worktreeId: string
  agent: string
  executionHostId: ExecutionHostId
  groupId: string
}): Promise<string> {
  const target = structuredAgentSessionTargetForHost(input.executionHostId)
  if (!target) {
    throw new Error('The chat execution host is unavailable')
  }
  const worktree = toRuntimeWorktreeSelector(input.worktreeId)
  const support = await callStructuredAgentSession<{ supported: boolean }>(
    target,
    'agentSession.createSupport',
    {
      worktree,
      agent: input.agent
    }
  )
  if (!support.supported) {
    throw new Error('This adapter cannot open a chat in this workspace')
  }
  const placesTab = await structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY
  )
  const sessionId = createStructuredAgentSessionId(input.agent, createBrowserUuid)
  const params = structuredAgentSessionCreateParams({
    sessionId,
    worktree,
    agent: input.agent,
    options: { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: 'ask' },
    ...(placesTab ? { tabPlacement: { groupId: input.groupId } } : {}),
    randomUuid: createBrowserUuid
  })
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >(target, 'agentSession.create', params)
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  return result.value.sessionId
}

export function launchCustomAgentChatFromMenu(
  customChat: { agent: string; executionHostId: ExecutionHostId } | undefined,
  worktreeId: string,
  groupId: string
): void {
  if (customChat) {
    void launchCustomAgentChat({ ...customChat, worktreeId, groupId }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    )
  }
}

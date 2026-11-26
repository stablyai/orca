import type { StructuredAgentId } from '../provider-handles/agent-session-provider-handle'
import type { AgentJournalMessageItem } from '../../journal/agent-session-journal-types'
import type { AgentSessionMutationEnvelope } from '../../agent-session-wire'
import type { z } from 'zod'
import type { SendBody } from '../../../rpc-contract/structured-agent-session/structured-agent-session-message-params'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from './structured-agent-session-mutation'

/** Send conversation identity only; the executing host derives transcript/account paths so paired clients cannot choose files or credentials. */
export type StructuredAgentSessionResumeSource = {
  /** claude: the session id. codex: the thread id. */
  providerSessionId: string
  /** Host-owned pane evidence; send only with the CLI-source create capability. */
  cliSource?: { workspaceId: string; paneKey: string }
}

/** The source chat and the response whose turn the fork copies through. */
export type StructuredAgentSessionForkSource = { sessionId: string; throughItemId: string }

export type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  forkFrom?: StructuredAgentSessionForkSource
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY`. */
  tabId?: string
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY`. */
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY`. */
  tabPlacement?: { groupId?: string; afterTabId?: string }
  /** A folder inside the workspace the chat runs in (a task group's); the host checks it. Outside the fingerprint. */
  launchDirectory?: string
}

export type StructuredAgentSessionFirstMessage = {
  clientMessageId: string
  /** A run's fields only from the host: a client's body is parsed as `SendBody`. */
  body: z.infer<typeof SendBody> &
    Pick<AgentJournalMessageItem, 'memorySource' | 'triggeredBy' | 'origin' | 'automationRun'>
  selection?: Readonly<Record<string, string>>
}

/** Share create fingerprints across clients and host recomputation; ambiguous transport failures replay this durable envelope. */
export function structuredAgentSessionCreateParams(args: {
  sessionId: string
  worktree: string
  agent: StructuredAgentId
  forkFrom?: StructuredAgentSessionForkSource
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** A display hint, outside the fingerprint: a retry may name a place that moved. */
  tabPlacement?: StructuredAgentSessionCreateParams['tabPlacement']
  launchDirectory?: string
  randomUuid: () => string
  now?: number
}): StructuredAgentSessionCreateParams {
  if (args.forkFrom && (args.resumeFrom || args.options || args.optionsMode)) {
    throw new Error('A fork inherits its source options and cannot also resume a conversation.')
  }
  const fields = {
    worktree: args.worktree,
    agent: args.agent,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
    ...(args.forkFrom ? { forkFrom: args.forkFrom } : {}),
    ...(args.tabId ? { tabId: args.tabId } : {}),
    ...(args.firstMessage ? { firstMessage: args.firstMessage } : {}),
    ...(args.optionsMode ? { optionsMode: args.optionsMode } : {}),
    ...(args.options ? { options: args.options } : {})
  }
  return {
    envelope: {
      sessionId: args.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(args.randomUuid, args.now),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: args.sessionId,
        ...fields
      })
    },
    ...fields,
    ...(args.tabPlacement ? { tabPlacement: args.tabPlacement } : {}),
    ...(args.launchDirectory ? { launchDirectory: args.launchDirectory } : {})
  }
}

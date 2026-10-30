import type { StructuredAgentId } from './agent-session-provider-handle'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import type { z } from 'zod'
import type { SendBody } from './rpc-contract/structured-agent-session-message-params'
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

export type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: StructuredAgentId
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY`. */
  tabId?: string
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY`. */
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY`. */
  tabPlacement?: { groupId?: string; afterTabId?: string }
}

export type StructuredAgentSessionFirstMessage = {
  clientMessageId: string
  body: z.infer<typeof SendBody>
  selection?: Readonly<Record<string, string>>
}

/** Provider-prefixed IDs use underscore-only suffix tokens for embedding in tab IDs/log keys. */
export function createStructuredAgentSessionId(
  agent: StructuredAgentId,
  randomUuid: () => string
): string {
  return `${agent}_${randomUuid().replaceAll('-', '_')}`
}

/** Validate only the generated suffix token so hyphenated agent names remain wire-compatible. */
export function isStructuredAgentSessionIdFor(agent: string, sessionId: string): boolean {
  const prefix = `${agent}_`
  return sessionId.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(sessionId.slice(prefix.length))
}

/** Share create fingerprints across clients and host recomputation; ambiguous transport failures replay this durable envelope. */
export function structuredAgentSessionCreateParams(args: {
  sessionId: string
  worktree: string
  agent: StructuredAgentId
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  /** A display hint, outside the fingerprint: a retry may name a place that moved. */
  tabPlacement?: StructuredAgentSessionCreateParams['tabPlacement']
  randomUuid: () => string
  now?: number
}): StructuredAgentSessionCreateParams {
  const fields = {
    worktree: args.worktree,
    agent: args.agent,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
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
    ...(args.tabPlacement ? { tabPlacement: args.tabPlacement } : {})
  }
}

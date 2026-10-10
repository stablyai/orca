import type { TuiAgent } from '../../../shared/tui-agent'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams,
  type StructuredAgentSessionFirstMessage,
  type StructuredAgentSessionResumeSource
} from '../../../shared/structured-agent-session-create'
import { resolveStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError,
  StructuredAgentSessionOwnerUnresolvedError
} from '@/lib/structured-agent-session-launch-errors'

export {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError,
  StructuredAgentSessionOwnerUnresolvedError
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  /** The host that owns the chat, fixed when the launch begins and persisted with it: worktree ids
   *  repeat across hosts, so it is never re-derived. */
  executionHostId: ExecutionHostId
  /** The runtime serving `executionHostId`. */
  target: RuntimeClientTarget
  agent: TuiAgent
  params: StructuredAgentSessionCreateParams
  createMessageSupport?: boolean
  createPrepared?: true
  prepareCreate?: () => void
  /** The saved selection create seeds, read when the intent is built. */
  seedOptions?: Readonly<Record<string, string>>
}

type LaunchSeed = Readonly<Record<string, string>> | undefined

/** What create will seed: this machine's saved selection for its own chats; for a paired server's,
 *  the server's own, which it reports when it admits the chat (absent from an older server). */
function launchSeedOptions(
  state: ReturnType<typeof useAppStore.getState>,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'target'>,
  agent: TuiAgent,
  hostSeedOptions: LaunchSeed
): { seedOptions?: Readonly<Record<string, string>> } {
  const seedOptions =
    owner.target.kind === 'local'
      ? resolveStructuredLaunchSeedOptions(state.settings?.nativeChatSessionOptions, agent)
      : hostSeedOptions
  return seedOptions ? { seedOptions } : {}
}

function structuredAgentSessionOwnerTarget(
  worktreeId: string,
  executionHostId: ExecutionHostId | null
): { executionHostId: ExecutionHostId; target: RuntimeClientTarget } {
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (!executionHostId || !target) {
    throw new StructuredAgentSessionOwnerUnresolvedError(worktreeId)
  }
  return { executionHostId, target }
}

/** `executionHostId` is the host the launch was routed to; absent, the catalog must name exactly
 *  one, or the launch is refused rather than sent to whichever host a fallback picks. */
export function createStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  agent: TuiAgent,
  executionHostId?: ExecutionHostId,
  resumeFrom?: StructuredAgentSessionResumeSource,
  hostSeedOptions?: LaunchSeed
): StructuredAgentSessionLaunchIntent {
  const owner = structuredAgentSessionOwnerTarget(
    worktreeId,
    executionHostId ?? resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
  )
  const sessionId = createStructuredAgentSessionId(agent, createBrowserUuid)
  return buildStructuredAgentSessionLaunchIntent(
    worktreeId,
    owner,
    agent,
    sessionId,
    resumeFrom,
    hostSeedOptions
  )
}

function buildStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'executionHostId' | 'target'>,
  agent: TuiAgent,
  sessionId: string,
  resumeFrom: StructuredAgentSessionResumeSource | undefined,
  hostSeedOptions: LaunchSeed
): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    structuredAgentSessionFocusOwner(owner.target),
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  return {
    sessionId,
    worktreeId,
    executionHostId: owner.executionHostId,
    target: owner.target,
    agent,
    params: structuredAgentSessionCreateParams({
      sessionId,
      worktree: toRuntimeWorktreeSelector(worktreeId),
      agent,
      ...(resumeFrom ? { resumeFrom } : {}),
      randomUuid: createBrowserUuid
    }),
    ...launchSeedOptions(state, owner, agent, hostSeedOptions)
  }
}

/** A definitive refusal consumed its operation id, but the provisional tab still owns its session. */
export function retryStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): StructuredAgentSessionLaunchIntent {
  return buildStructuredAgentSessionLaunchIntent(
    intent.worktreeId,
    intent,
    intent.agent,
    intent.sessionId,
    intent.params.resumeFrom,
    intent.seedOptions
  )
}

/** Rebuild a reload-surviving intent with the caller's current worktree selector. */
export function restoreStructuredAgentSessionLaunchIntent(args: {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  /** A paired server's seed, kept with the launch so a reload shows what create runs. */
  seedOptions?: Readonly<Record<string, string>>
  firstMessage?: StructuredAgentSessionFirstMessage
  options?: Readonly<Record<string, string>>
  createMessageSupport?: boolean
}): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
  const { target } = structuredAgentSessionOwnerTarget(args.worktreeId, args.executionHostId)
  recordWebSessionFocusIntent(
    structuredAgentSessionFocusOwner(target),
    args.worktreeId,
    `agent-session:${args.sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, args.worktreeId)
  )
  return {
    sessionId: args.sessionId,
    worktreeId: args.worktreeId,
    executionHostId: args.executionHostId,
    target,
    agent: args.agent,
    params: {
      envelope: {
        sessionId: args.sessionId,
        clientOperationId: args.clientOperationId,
        expectedRuntimeFence: args.expectedRuntimeFence,
        payloadFingerprint: args.payloadFingerprint
      },
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      agent: args.agent,
      ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
      ...(args.firstMessage ? { firstMessage: args.firstMessage } : {}),
      ...(args.options ? { options: args.options } : {})
    },
    ...(args.createMessageSupport === undefined
      ? {}
      : { createMessageSupport: args.createMessageSupport }),
    ...(args.createMessageSupport === undefined ? {} : { createPrepared: true as const }),
    ...launchSeedOptions(state, { target }, args.agent, args.seedOptions)
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    structuredAgentSessionFocusOwner(intent.target),
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

export {
  launchStructuredAgentSession,
  type StructuredLaunchHostSeedListener
} from './structured-agent-session-launch-create-call'

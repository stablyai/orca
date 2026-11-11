import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../../../../shared/agent-session/structured-agent-session-create'
import type {
  StructuredAgentSessionCreateParams,
  StructuredAgentSessionFirstMessage,
  StructuredAgentSessionForkSource,
  StructuredAgentSessionResumeSource
} from '../../../../../shared/agent-session/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { structuredLaunchSeedOptions } from '../../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { useAppStore } from '@/store/index'
import {
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { StructuredAgentSessionOwnerUnresolvedError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import type { StructuredAgentSessionCreateGate } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import './structured-agent-session-launch-abandon'
import './structured-agent-session-launch-create-call'
import type { StructuredLaunchSurfaceAddress } from './structured-agent-session-launch-record'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  /** Fix/persist execution host when launch begins; same workspace IDs on other hosts must never alter ownership. */
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
  agent: TuiAgent
  params: StructuredAgentSessionCreateParams
  sendSelectionSupport?: boolean
  /** Client-only admission requirement; reacquired from the child after reload. */
  forkRequiresInheritedOriginal?: boolean
  sendSkillsSupport?: boolean
  createMessageSupport?: boolean
  createPrepared?: true
  prepareCreate?: (hostTakesExplicitOptions: boolean) => void
  beforeCreate?: () => boolean
  createAfter?: Promise<StructuredAgentSessionCreateGate>
  surfaceAddress?: StructuredLaunchSurfaceAddress
  /** The saved selection create seeds, read when the intent is built. */
  explicitLaunchOptions?: Readonly<Record<string, string>>
  seedOptions?: Readonly<Record<string, string>>
}

type LaunchSeed = Readonly<Record<string, string>> | undefined

/** Seed local saved selection for local chats; paired hosts report their own admitted seed, absent on older servers. */
function launchSeedOptions(
  state: ReturnType<typeof useAppStore.getState>,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'target'>,
  agent: TuiAgent,
  hostSeedOptions: LaunchSeed,
  resumeFrom?: StructuredAgentSessionResumeSource
): { seedOptions?: Readonly<Record<string, string>> } {
  const seedOptions =
    owner.target.kind === 'local'
      ? structuredLaunchSeedOptions(
          resumeFrom ? { ...state.settings, agentLaunchChoices: undefined } : state.settings,
          agent
        )
      : resumeFrom
        ? undefined
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

/** Use routed executionHostId or require exactly one catalog owner; never choose a launch host by fallback. */
export function createStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  agent: TuiAgent,
  executionHostId?: ExecutionHostId,
  resumeFrom?: StructuredAgentSessionResumeSource,
  hostSeedOptions?: LaunchSeed,
  activate = true,
  forkFrom?: StructuredAgentSessionForkSource
): StructuredAgentSessionLaunchIntent {
  const owner = structuredAgentSessionOwnerTarget(
    worktreeId,
    executionHostId ?? resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
  )
  const sessionId = createStructuredAgentSessionId(agent, createNonSecureContextUuid)
  if (activate) {
    recordWebSessionFocusIntent(
      structuredAgentSessionFocusOwner(owner.target),
      worktreeId,
      `agent-session:${sessionId}`,
      undefined,
      resolveWebSessionVisibleTabId(useAppStore.getState(), worktreeId)
    )
  }
  return buildStructuredAgentSessionLaunchIntent(
    worktreeId,
    owner,
    agent,
    sessionId,
    resumeFrom,
    hostSeedOptions,
    forkFrom
  )
}

function buildStructuredAgentSessionLaunchIntent(
  worktreeId: string,
  owner: Pick<StructuredAgentSessionLaunchIntent, 'executionHostId' | 'target'>,
  agent: TuiAgent,
  sessionId: string,
  resumeFrom: StructuredAgentSessionResumeSource | undefined,
  hostSeedOptions: LaunchSeed,
  forkFrom: StructuredAgentSessionForkSource | undefined
): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
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
      ...(forkFrom ? { forkFrom } : {}),
      randomUuid: createNonSecureContextUuid
    }),
    ...(forkFrom ? {} : launchSeedOptions(state, owner, agent, hostSeedOptions, resumeFrom))
  }
}

/** A definitive refusal consumed its operation id, but the provisional tab still owns its session. */
export function retryStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent,
  retainOpening = false,
  /** Starts a new conversation instead of resuming one the agent never saved. */
  fresh = false
): StructuredAgentSessionLaunchIntent {
  if (retainOpening) {
    const { beforeCreate: _beforeCreate, createAfter: _createAfter, ...retained } = intent
    return {
      ...retained,
      params: {
        ...intent.params,
        envelope: {
          ...intent.params.envelope,
          clientOperationId: createStructuredAgentSessionOperationId(createNonSecureContextUuid)
        }
      }
    }
  }
  return {
    ...buildStructuredAgentSessionLaunchIntent(
      intent.worktreeId,
      intent,
      intent.agent,
      intent.sessionId,
      fresh ? undefined : intent.params.resumeFrom,
      intent.seedOptions,
      intent.params.forkFrom
    ),
    forkRequiresInheritedOriginal: intent.forkRequiresInheritedOriginal,
    explicitLaunchOptions: intent.explicitLaunchOptions
  }
}

export function restoreStructuredAgentSessionLaunchIntent(args: {
  worktreeId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: TuiAgent
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  forkFrom?: StructuredAgentSessionForkSource
  /** A paired server's seed, kept with the launch so a reload shows what create runs. */
  explicitLaunchOptions?: Readonly<Record<string, string>>
  seedOptions?: Readonly<Record<string, string>>
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
  sendSelectionSupport?: boolean
  createMessageSupport?: boolean
}): StructuredAgentSessionLaunchIntent {
  const state = useAppStore.getState()
  const { target } = structuredAgentSessionOwnerTarget(args.worktreeId, args.executionHostId)
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
      ...(args.forkFrom ? { forkFrom: args.forkFrom } : {}),
      ...(args.firstMessage ? { firstMessage: args.firstMessage } : {}),
      ...(args.optionsMode ? { optionsMode: args.optionsMode } : {}),
      ...(args.options ? { options: args.options } : {})
    },
    ...(args.createMessageSupport === undefined
      ? {}
      : { createMessageSupport: args.createMessageSupport }),
    ...(args.createMessageSupport === undefined ? {} : { createPrepared: true as const }),
    ...(args.explicitLaunchOptions ? { explicitLaunchOptions: args.explicitLaunchOptions } : {}),
    ...(args.forkFrom
      ? {}
      : args.createMessageSupport !== undefined
        ? args.seedOptions
          ? { seedOptions: args.seedOptions }
          : {}
        : launchSeedOptions(state, { target }, args.agent, args.seedOptions, args.resumeFrom))
  }
}

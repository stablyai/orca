import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { StructuredNativeChatHostStatusBlocker } from '../../../shared/structured-native-chat-launch-route'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
// Why: the `connection-context` facade imports the store root; the resolver's own module keeps
// this input builder importable from anywhere in the launch graph without a cycle.
import {
  getConnectionIdFromState,
  getRepoConnectionIdFromState
} from '@/lib/connection-owner-resolution'
import {
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext
} from '@/lib/local-preflight-context'
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { readLocalRuntimeCapabilitiesOrUnknown } from '@/runtime/local-runtime-capabilities'
import {
  resolveStructuredChatHostVerdict,
  type StructuredChatHostAdmission
} from '@/runtime/structured-chat-host-verdict'
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'

export type ProspectiveWorkspaceKind = NonNullable<AgentLaunchRoutingInput['workspaceKind']>

/**
 * The workspace an agent launch targets. It may not exist yet: the create dialogs pick the route
 * before the worktree or folder workspace row lands, so they name the repo, the runtime
 * environment, or the host instead of a worktree.
 */
export type ProspectiveWorkspace = {
  kind: ProspectiveWorkspaceKind
  repoId?: string
  worktreeId?: string
  /** Only for workspaces that do not exist yet; with `worktreeId` the store's owner resolution wins. */
  executionHostId?: string
  runtimeEnvironmentId?: string | null
}

export type AgentLaunchRouteStore = Parameters<typeof getExecutionHostIdForWorktree>[0] &
  Parameters<typeof getLocalProjectExecutionRuntimeContext>[0] &
  Parameters<typeof getConnectionIdFromState>[0] & {
    settings?: AgentLaunchRoutingInput['settings']
    /** Published host status. Absent before the runtime catalog hydrates, which reads as unknown. */
    runtimeStatusByEnvironmentId?: ReadonlyMap<string, RuntimeEnvironmentStatus>
  }

export type AgentLaunchRouteArgs = {
  agent: TuiAgent
  workspace: ProspectiveWorkspace
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** A cwd or explicit CLI args only a terminal can apply. */
  tuiCustomization?: { cwd?: string | null; agentArgs?: string | null }
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function workspaceKindForWorktreeId(worktreeId: string): ProspectiveWorkspaceKind {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  return parseWorkspaceKey(worktreeId)?.type === 'folder' ? 'folder' : 'git-worktree'
}

/** The host a launch would run on, resolved from a workspace that may not exist yet. */
export function resolveProspectiveWorkspaceExecutionHostId(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
) {
  if (workspace.worktreeId) {
    return getExecutionHostIdForWorktree(store, workspace.worktreeId)
  }
  if (workspace.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(workspace.runtimeEnvironmentId)
  }
  return workspace.executionHostId ?? LOCAL_EXECUTION_HOST_ID
}

function resolveProjectRuntime(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  executionHostId: string
): AgentLaunchRoutingInput['projectRuntime'] {
  // Why: a remote host owns its own runtime; the local project's Windows/WSL preference is
  // not evidence about it, and the remote blocker fires before it would be read.
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID || workspace.kind === 'floating') {
    return undefined
  }
  return workspace.worktreeId
    ? getLocalProjectExecutionRuntimeContext(store, workspace.worktreeId)
    : getLocalRepoProjectExecutionRuntimeContext(store, workspace.repoId)
}

function resolveTranscriptIsLocalReadable(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  executionHostId: string
): boolean {
  if (workspace.worktreeId) {
    const connectionId = getConnectionIdFromState(store, workspace.worktreeId)
    // Why: right after creation the worktree row has not landed, and only `undefined` — "cannot
    // determine the host" — hands the question to the repo. A resolved `null` is the local answer.
    return isNativeChatTranscriptLocalReadable(
      connectionId === undefined
        ? getRepoConnectionIdFromState(store, workspace.repoId)
        : connectionId
    )
  }
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'ssh' ? isNativeChatTranscriptLocalReadable(host.targetId) : true
}

type HostCapabilityEvidence = {
  hostCapabilities: readonly RuntimeCapability[] | null
  hostStatusBlocker?: StructuredNativeChatHostStatusBlocker
}

/** The host publishes its effective structured-chat admission alongside its capabilities; one that
 *  publishes none has unknown policy, which is not the same as policy off. */
function readPublishedAdmission(
  status: RuntimeStatus | null | undefined
): StructuredChatHostAdmission {
  const enabled = (status as { structuredSessionAdmission?: { enabled?: unknown } } | null)
    ?.structuredSessionAdmission?.enabled
  return typeof enabled === 'boolean' ? { enabled } : undefined
}

/**
 * Capability evidence about the machine that would actually run the session. Reading the local
 * cache for a remote launch would admit or refuse it on facts about the wrong machine, so a
 * `runtime:` host is read from its own published snapshot; an `ssh:` host publishes none, and an
 * unanswerable host stays `null` rather than becoming a refusal.
 */
export function resolveHostCapabilityEvidence(
  store: AgentLaunchRouteStore,
  executionHostId: string
): HostCapabilityEvidence {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return { hostCapabilities: readLocalRuntimeCapabilitiesOrUnknown() }
  }
  if (host?.kind !== 'runtime') {
    return { hostCapabilities: null }
  }
  const entry = store.runtimeStatusByEnvironmentId?.get(host.environmentId)
  const capabilities = entry?.snapshot?.status?.capabilities ?? []
  switch (
    resolveStructuredChatHostVerdict({
      entry,
      capability: STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      admission: readPublishedAdmission(entry?.snapshot?.status)
    })
  ) {
    case 'supported':
    case 'host-refuses-capability':
      return { hostCapabilities: capabilities }
    case 'host-policy-disabled':
      return { hostCapabilities: capabilities, hostStatusBlocker: 'host-policy-disabled' }
    case 'host-disconnected':
      return { hostCapabilities: null, hostStatusBlocker: 'host-disconnected' }
    // Skew is the absence of an answer too, alongside the ask-again verdicts: none is a refusal.
    case 'version-or-auth-skew':
    case 'unknown-checking':
    case 'unknown-no-entry':
    case 'unknown-stale':
    case 'unknown-unavailable':
      return { hostCapabilities: null }
  }
}

/** The one place that gathers what a launch route decision needs; only the planner resolves on it. */
export function buildAgentLaunchRouteInput(
  store: AgentLaunchRouteStore,
  args: AgentLaunchRouteArgs
): AgentLaunchRoutingInput {
  const { agent, workspace, tuiCustomization } = args
  const executionHostId = resolveProspectiveWorkspaceExecutionHostId(store, workspace)
  return {
    agent,
    settings: store.settings,
    executionHostId,
    ...resolveHostCapabilityEvidence(store, executionHostId),
    workspaceKind: workspace.kind,
    projectRuntime: resolveProjectRuntime(store, workspace, executionHostId),
    promptDelivery: args.promptDelivery,
    launchText: args.prompt,
    nativeChatTranscriptIsLocalReadable: resolveTranscriptIsLocalReadable(
      store,
      workspace,
      executionHostId
    ),
    requiresTuiLaunchCustomization:
      Boolean(tuiCustomization?.cwd?.trim()) ||
      hasExplicitTuiAgentArgs(agent, tuiCustomization?.agentArgs) ||
      hasExplicitTuiLaunchCustomization(store.settings, agent),
    initialSessionOptions: args.initialSessionOptions
  }
}

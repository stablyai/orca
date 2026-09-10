import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
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

function resolveExecutionHostId(store: AgentLaunchRouteStore, workspace: ProspectiveWorkspace) {
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

/** The one place that gathers what a launch route decision needs; only the planner resolves on it. */
export function buildAgentLaunchRouteInput(
  store: AgentLaunchRouteStore,
  args: AgentLaunchRouteArgs
): AgentLaunchRoutingInput {
  const { agent, workspace, tuiCustomization } = args
  const executionHostId = resolveExecutionHostId(store, workspace)
  return {
    agent,
    settings: store.settings,
    executionHostId,
    hostCapabilities: readLocalRuntimeCapabilitiesOrUnknown(),
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

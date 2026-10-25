import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { requestsCwdOutsideWorkspaceRootForWorkspace } from '../../../shared/terminal-startup-cwd'
import type { TuiAgent } from '../../../shared/tui-agent'
import { workspaceKindForWorktreeId } from '../../../shared/workspace-launch-kind'
import type { AgentLaunchRoutingInput } from '@/lib/agent-launch-routing'
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
import type { NativeChatLaunchPromptDelivery } from '@/lib/native-chat-launch-prompt-delivery'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { readLocalRuntimeCapabilitiesOrUnknown } from '@/runtime/local-runtime-capabilities'
import { resolveStructuredAgentSessionOwner } from '@/runtime/structured-agent-session-owner'
import { pairedHostClientCapabilities } from '@/runtime/paired-host-client-capabilities'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { readHostStructuredAgents } from '@/runtime/host-structured-agents'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'

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

export type AgentLaunchRouteStore = {
  settings?: AgentLaunchRoutingInput['settings']
  /** Each paired host's last status, which carries its capabilities. */
  runtimeStatusByEnvironmentId?: AppState['runtimeStatusByEnvironmentId']
  /** Where each workspace's root is, so a cwd naming it is not read as a custom directory. First
   *  in the intersection so these lookups resolve to the full records. */
  worktreesByRepo?: AppState['worktreesByRepo']
  folderWorkspaces?: AppState['folderWorkspaces']
} & Parameters<typeof getExecutionHostIdForWorktree>[0] &
  Parameters<typeof getLocalProjectExecutionRuntimeContext>[0] &
  Parameters<typeof getConnectionIdFromState>[0]

/** Every slice the route readers take: a publisher that watches these sees every route change. */
const AGENT_LAUNCH_ROUTE_KEYS = [
  'settings',
  'runtimeStatusByEnvironmentId',
  'worktreesByRepo',
  'folderWorkspaces',
  'repos',
  'detectedWorktreesByRepo',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds',
  'activeRepoId',
  'projects'
] as const satisfies readonly (keyof AgentLaunchRouteStore)[]
type AgentLaunchRouteKey = (typeof AGENT_LAUNCH_ROUTE_KEYS)[number]
// Completeness, not just membership: a reader input missing from the list fails to compile.
type AssertNoMissingRouteKey<T extends never> = T
export type AgentLaunchRouteKeysAreComplete = AssertNoMissingRouteKey<
  Exclude<keyof AgentLaunchRouteStore, AgentLaunchRouteKey>
>
export type AgentLaunchRouteView = { [K in AgentLaunchRouteKey]: AppState[K] }

export const agentLaunchRouteInputsChanged = (
  next: AgentLaunchRouteView,
  previous: AgentLaunchRouteView
): boolean => AGENT_LAUNCH_ROUTE_KEYS.some((key) => next[key] !== previous[key])

let lastRouteView: AgentLaunchRouteView | undefined
/** Same object until a route slice changes, so an unrelated write allocates nothing. */
export function selectAgentLaunchRouteView(state: AppState): AgentLaunchRouteView {
  if (!lastRouteView || agentLaunchRouteInputsChanged(state, lastRouteView)) {
    lastRouteView = {
      settings: state.settings,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      worktreesByRepo: selectWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      repos: state.repos,
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      activeRepoId: state.activeRepoId,
      projects: state.projects
    }
  }
  return lastRouteView
}

export type AgentLaunchRouteArgs = {
  agent: TuiAgent
  workspace: ProspectiveWorkspace
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** A working directory only a terminal can apply; a structured session runs in its workspace. */
  tuiCustomization?: { cwd?: string | null }
}

export { workspaceKindForWorktreeId }
export const worktreeLaunchWorkspace = (worktreeId: string): ProspectiveWorkspace => ({
  kind: workspaceKindForWorktreeId(worktreeId),
  worktreeId
})

function resolveExecutionHostId(store: AgentLaunchRouteStore, workspace: ProspectiveWorkspace) {
  if (workspace.worktreeId) {
    return getExecutionHostIdForWorktree(store, workspace.worktreeId)
  }
  if (workspace.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(workspace.runtimeEnvironmentId)
  }
  return workspace.executionHostId ?? LOCAL_EXECUTION_HOST_ID
}

/** The launch is decided on what the host that would run it supports, not on this machine. */
export function resolveHostCapabilities(
  store: Pick<AgentLaunchRouteStore, 'runtimeStatusByEnvironmentId'>,
  executionHostId: string
): readonly string[] | null {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'runtime'
    ? (lastVerifiedRuntimeStatus(store.runtimeStatusByEnvironmentId?.get(host.environmentId))
        ?.capabilities ?? null)
    : readLocalRuntimeCapabilitiesOrUnknown()
}

function resolveProjectRuntime(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace,
  executionHostId: string
): AgentLaunchRoutingInput['projectRuntime'] {
  // Why: a remote host owns its own runtime; the local project's Windows/WSL preference is
  // not evidence about it, and a paired host's createSupport answers for its own.
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

function hostStructuredAgentsInput(
  store: AgentLaunchRouteStore,
  executionHostId: string
): Pick<AgentLaunchRoutingInput, 'hostStructuredAgents'> {
  const agents = readHostStructuredAgents(executionHostId, store.runtimeStatusByEnvironmentId)
  return agents ? { hostStructuredAgents: agents.map((row) => row.agent) } : {}
}

/** The execution owner is resolved before agent policy. */
export function resolveAgentLaunchHost(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
) {
  const owner = workspace.worktreeId
    ? resolveStructuredAgentSessionOwner(store, workspace.worktreeId)
    : undefined
  const executionHostId = owner ?? resolveExecutionHostId(store, workspace)
  return {
    owner,
    executionHostId,
    hostCapabilities: owner === null ? null : resolveHostCapabilities(store, executionHostId)
  }
}

/** The one place that gathers what a launch route decision needs; only the planner resolves on it. */
export function buildAgentLaunchRouteInput(
  store: AgentLaunchRouteStore,
  args: AgentLaunchRouteArgs
): AgentLaunchRoutingInput {
  const { agent, workspace, tuiCustomization } = args
  const { executionHostId, hostCapabilities } = resolveAgentLaunchHost(store, workspace)
  return {
    agent,
    settings: store.settings,
    executionHostId,
    hostCapabilities,
    ...(parseExecutionHostId(executionHostId)?.kind === 'runtime'
      ? { clientCapabilities: pairedHostClientCapabilities() }
      : {}),
    workspaceKind: workspace.kind,
    projectRuntime: resolveProjectRuntime(store, workspace, executionHostId),
    promptDelivery: args.promptDelivery,
    launchText: args.prompt,
    nativeChatTranscriptIsLocalReadable: resolveTranscriptIsLocalReadable(
      store,
      workspace,
      executionHostId
    ),
    // A cwd decides the route only when it names somewhere other than the workspace root; the
    // host applies the same rule (`agent-launch-mode.ts`), so the two never disagree on it.
    startsOutsideWorkspaceRoot: requestsCwdOutsideWorkspaceRootForWorkspace({
      workspaceId: workspace.worktreeId,
      requestedCwd: tuiCustomization?.cwd,
      workspacePath: workspace.worktreeId
        ? findWorktreeById(selectWorktreesByRepo(store) ?? {}, workspace.worktreeId)?.path
        : undefined,
      resolveFolderWorkspacePath: (folderWorkspaceId) =>
        selectFolderWorkspaces(store)?.find((entry) => entry.id === folderWorkspaceId)?.folderPath
    }),
    ...hostStructuredAgentsInput(store, executionHostId)
  }
}

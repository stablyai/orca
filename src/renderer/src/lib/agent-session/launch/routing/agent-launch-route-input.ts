import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'
import { authorityKey } from '../../../../../../shared/host-authority'
import {
  resolveOwner,
  runtimeEnvironmentIdForWorkspaceOwner
} from '@/lib/workspace/ownership/resolve-owner'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import {
  type ExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import { findFirstIndexedWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { requestsCwdOutsideWorkspaceRootForWorkspace } from '../../../../../../shared/shell/launch/terminal-startup-cwd'
import { workspaceKindForWorktreeId } from '../../../../../../shared/agent-launch/contracts/workspace-launch-kind'
import {
  getConnectionIdForWorktreeCopy,
  getConnectionIdFromState,
  getRepoConnectionIdFromState
} from '@/lib/workspace/ownership/connection-owner-resolution'
import {
  getLocalProjectExecutionRuntimeContext,
  getLocalRepoProjectExecutionRuntimeContext
} from '@/runtime/hosts/preflight/local-preflight-context'
import { isNativeChatTranscriptLocalReadable } from '../../../../../../shared/native-chat/transcript/native-chat-transcript-readability'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { readLocalRuntimeCapabilitiesOrUnknown } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resolveStructuredAgentSessionOwner } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { pairedHostClientCapabilities } from '@/runtime/rpc/targets/paired-host-client-capabilities'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { readHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { ProjectLaunchContext } from '../../../../../../shared/rpc-contract/preflight-params'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchRoutingInput } from '@/lib/agent-session/launch/routing/agent-launch-routing'
import type { NativeChatLaunchPromptDelivery } from '@/lib/agent-session/launch/prompt/native-chat-launch-prompt-delivery'

// Import the resolver directly: the connection-context facade reaches the store root and creates a launch-graph cycle.

export type ProspectiveWorkspaceKind = NonNullable<AgentLaunchRoutingInput['workspaceKind']>

/** A launch target may precede its workspace row; create dialogs identify the repo, runtime or host until then. */
export type ProspectiveWorkspace = {
  executionContext?: ProjectLaunchContext['executionContext']
  kind: ProspectiveWorkspaceKind
  repoId?: string
  worktreeId?: string
  /** Qualifies an existing workspace copy; creation hints below do not. */
  hostId?: ExecutionHostId
  /** Only for workspaces that do not exist yet; with `worktreeId` the store's owner resolution wins. */
  executionHostId?: string
  runtimeEnvironmentId?: string | null
}

export type AgentLaunchRouteStore = {
  settings?: AgentLaunchRoutingInput['settings']
  runtimeStatusByEnvironmentId?: AppState['runtimeStatusByEnvironmentId']
  /** Workspace roots distinguish a root cwd from a custom one; place these first so intersection lookups retain full records. */
  worktreesByRepo?: AppState['worktreesByRepo']
  detectedWorktreesByRepo?: AppState['detectedWorktreesByRepo']
  folderWorkspaces?: AppState['folderWorkspaces']
} & Parameters<typeof getExecutionHostIdForWorktree>[0] &
  Parameters<typeof getLocalProjectExecutionRuntimeContext>[0] &
  Parameters<typeof getConnectionIdFromState>[0]

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
  selectedExecutionHostId?: ExecutionHostId
  agent: TuiAgent
  /** Invocation preference; host admission can still fall back to Terminal. */
  preferredSurface?: 'chat'
  workspace: ProspectiveWorkspace
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  tuiCustomization?: { cwd?: string | null }
}

export { workspaceKindForWorktreeId }
export { worktreeLaunchWorkspace } from './worktree-launch-workspace'

function resolveExecutionHostId(store: AgentLaunchRouteStore, workspace: ProspectiveWorkspace) {
  if (workspace.worktreeId) {
    return workspace.hostId ?? getExecutionHostIdForWorktree(store, workspace.worktreeId)
  }
  if (workspace.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(workspace.runtimeEnvironmentId)
  }
  return workspace.executionHostId ?? LOCAL_EXECUTION_HOST_ID
}

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
  executionHostId: string,
  selectedWorkspace?: Worktree
): AgentLaunchRoutingInput['projectRuntime'] {
  // Remote hosts choose their own runtime; local Windows/WSL preferences cannot override paired createSupport.
  if (executionHostId !== LOCAL_EXECUTION_HOST_ID || workspace.kind === 'floating') {
    return undefined
  }
  if (workspace.hostId && workspace.worktreeId) {
    const repo =
      selectedWorkspace &&
      findIndexedRepoOwnerForHost(store.repos, selectedWorkspace.repoId, workspace.hostId)
    return selectedWorkspace && repo
      ? getLocalProjectExecutionRuntimeContext(store, workspace.worktreeId, undefined, undefined, {
          worktree: selectedWorkspace,
          repo
        })
      : undefined
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
    const connectionId = workspace.hostId
      ? getConnectionIdForWorktreeCopy(store, workspace.worktreeId, workspace.hostId)
      : getConnectionIdFromState(store, workspace.worktreeId)
    // Only undefined ownership delegates to the repo during hydration; resolved null authorizes local ownership.
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

export function resolveAgentLaunchHost(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
) {
  const selected =
    workspace.worktreeId && workspace.hostId
      ? resolveOwner(store, { workspaceId: workspace.worktreeId, hostId: workspace.hostId })
      : undefined
  const selectedId = selected?.kind === 'resolved' ? authorityKey(selected.owner) : null
  const owner = workspace.worktreeId
    ? workspace.hostId
      ? selectedId && structuredAgentSessionTargetForHost(selectedId)
        ? selectedId
        : null
      : resolveStructuredAgentSessionOwner(store, workspace.worktreeId)
    : undefined
  const executionHostId = owner ?? resolveExecutionHostId(store, workspace)
  return {
    owner,
    executionHostId,
    hostCapabilities: owner === null ? null : resolveHostCapabilities(store, executionHostId)
  }
}

/** Inventory and preferences belong to the server even when the terminal runs in nested SSH. */
export function resolveAgentLaunchInventoryHost(
  store: AgentLaunchRouteStore,
  workspace: ProspectiveWorkspace
): string {
  const owner = workspace.worktreeId
    ? runtimeEnvironmentIdForWorkspaceOwner(store, {
        workspaceId: workspace.worktreeId,
        ...(workspace.hostId ? { hostId: workspace.hostId } : {})
      })
    : undefined
  return owner?.kind === 'resolved' && owner.environmentId
    ? toRuntimeExecutionHostId(owner.environmentId)
    : resolveAgentLaunchHost(store, workspace).executionHostId
}

export function buildAgentLaunchRouteInput(
  store: AgentLaunchRouteStore,
  args: AgentLaunchRouteArgs
): AgentLaunchRoutingInput {
  const { agent, tuiCustomization } = args
  const workspace = args.selectedExecutionHostId
    ? { ...args.workspace, hostId: args.selectedExecutionHostId }
    : args.workspace
  const { executionHostId, hostCapabilities } = resolveAgentLaunchHost(store, workspace)
  const selectedWorkspace =
    workspace.worktreeId && workspace.hostId
      ? findKnownWorktreeById(
          {
            ...store,
            worktreesByRepo: selectWorktreesByRepo(store) ?? {},
            folderWorkspaces: selectFolderWorkspaces(store) ?? [],
            detectedWorktreesByRepo: selectDetectedWorktreesByRepo(store) ?? {},
            floatingWorkspacePath: null
          },
          workspace.worktreeId,
          workspace.hostId
        )
      : undefined
  return {
    agent,
    settings: store.settings,
    preferredSurface: args.preferredSurface,
    executionHostId,
    hostCapabilities,
    ...(parseExecutionHostId(executionHostId)?.kind === 'runtime'
      ? { clientCapabilities: pairedHostClientCapabilities() }
      : {}),
    workspaceKind: workspace.kind,
    projectExecutionKind: workspace.executionContext?.kind,
    projectRuntime:
      workspace.executionContext?.kind === 'host'
        ? workspace.executionContext.projectRuntime
        : resolveProjectRuntime(store, workspace, executionHostId, selectedWorkspace),
    promptDelivery: args.promptDelivery,
    launchText: args.prompt,
    nativeChatTranscriptIsLocalReadable: resolveTranscriptIsLocalReadable(
      store,
      workspace,
      executionHostId
    ),
    // Only custom cwd forces a terminal; workspace-root cwd follows the same rule as host agent-launch-mode.ts.
    startsOutsideWorkspaceRoot: tuiCustomization?.cwd?.trim()
      ? requestsCwdOutsideWorkspaceRootForWorkspace({
          workspaceId: workspace.worktreeId,
          requestedCwd: tuiCustomization?.cwd,
          workspacePath: workspace.hostId
            ? selectedWorkspace?.path
            : workspace.worktreeId
              ? findFirstIndexedWorktree<Worktree>(
                  selectWorktreesByRepo(store) ?? {},
                  workspace.worktreeId
                )?.path
              : undefined,
          resolveFolderWorkspacePath: (folderWorkspaceId) =>
            workspace.hostId
              ? selectedWorkspace?.path
              : selectFolderWorkspaces(store)?.find((entry) => entry.id === folderWorkspaceId)
                  ?.folderPath
        })
      : false,
    ...hostStructuredAgentsInput(store, executionHostId)
  }
}

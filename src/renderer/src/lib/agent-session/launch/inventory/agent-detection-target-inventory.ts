import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import '../../../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { PREFLIGHT_PROJECT_LAUNCH_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/preflight-runtime-capabilities'
import type { ProjectLaunchContext } from '../../../../../../shared/rpc-contract/preflight/preflight-params'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey,
  type AgentDetectionOwnerState
} from '@/lib/agent-session/launch/inventory/useAgentDetectionTarget'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ManagedAgentCommands } from '../../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  LOCAL_MANAGED_AGENT_HOST,
  readManagedAgentCommands,
  runtimeManagedAgentHost
} from '@/store/slices/agent-inventory/managed-agent-launch-commands'
import { getLocalAgentPreflightContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'

type DetectionReadState = Pick<
  AppState,
  | 'detectedAgentIds'
  | 'localDetectedAgentIdsByContext'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
>

type DetectionActionState = Pick<
  AppState,
  'ensureDetectedAgents' | 'ensureRemoteDetectedAgents' | 'ensureRuntimeDetectedAgents'
>

export type WorktreeAgentInventoryState = AgentDetectionOwnerState &
  DetectionReadState &
  DetectionActionState

/** The agent list a detection target's host last reported; null while it has not loaded. */
export function readDetectedAgentsForTarget(
  state: DetectionReadState,
  target: AgentDetectionTarget
): TuiAgent[] | null {
  if (target.kind === 'ssh') {
    return state.remoteDetectedAgentIds[target.connectionId] ?? null
  }
  if (target.kind === 'runtime') {
    const key = getRuntimeAgentInventoryKey(target.environmentId, target.worktreeId)
    return state.runtimeDetectedAgentIds[key] ?? null
  }
  return target.contextKey
    ? (state.localDetectedAgentIdsByContext[target.contextKey] ?? null)
    : state.detectedAgentIds
}

export function ensureDetectedAgentsForTarget(
  state: DetectionActionState,
  target: AgentDetectionTarget
): Promise<TuiAgent[]> {
  if (target.kind === 'ssh') {
    return state.ensureRemoteDetectedAgents(target.connectionId)
  }
  if (target.kind === 'runtime') {
    return state.ensureRuntimeDetectedAgents(target.environmentId, target.worktreeId)
  }
  return state.ensureDetectedAgents(target.worktreeId)
}

function detectionTargetForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): AgentDetectionTarget | undefined {
  const target = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  )
  // Why: a local project's own runtime (native vs WSL) decides its PATH, not the focused one.
  return target?.kind === 'local' && !target.worktreeId && worktreeId
    ? { ...target, worktreeId }
    : target
}

/** The worktree host's agent list; null while unloaded or while its owner is unresolved. */
export function readDetectedAgentsForWorktree(
  state: AgentDetectionOwnerState & DetectionReadState,
  worktreeId: string | null
): TuiAgent[] | null {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? readDetectedAgentsForTarget(state, target) : null
}

/** Ask the workspace owner, including hub-owned SSH; unresolved owners list nothing rather than probing this client. */
export function ensureDetectedAgentsForWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string | null
): Promise<TuiAgent[]> {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? ensureDetectedAgentsForTarget(state, target) : Promise.resolve([])
}

export function getDetectionTargetIdentityForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): string | null {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? JSON.stringify(target) : null
}

export async function loadDetectedAgentsForWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string | null
): Promise<TuiAgent[]> {
  const cached = readDetectedAgentsForWorktree(state, worktreeId)
  // Why: a shortcut pressed before the tab bar's probe lands must wait for it, not report "none".
  return cached?.length ? cached : ensureDetectedAgentsForWorktree(state, worktreeId)
}

export type RepoHostFields = { connectionId?: string | null; executionHostId?: string | null }

/** Resolve project agents before workspace creation; paired projects return null until the new workspace identifies its server-owned SSH/WSL target. */
export function ensureDetectedAgentsForRepo(
  state: DetectionActionState,
  repo: RepoHostFields
): Promise<TuiAgent[]> | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    return null
  }
  return host?.kind === 'ssh'
    ? state.ensureRemoteDetectedAgents(host.targetId)
    : state.ensureDetectedAgents()
}

/** A just-created workspace's agents; names it to its project's host while the new row hydrates. */
export function ensureDetectedAgentsForNewWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string,
  repo: RepoHostFields
): Promise<TuiAgent[]> {
  const target = detectionTargetForWorktree(state, worktreeId)
  if (target) {
    return ensureDetectedAgentsForTarget(state, target)
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? state.ensureRuntimeDetectedAgents(host.environmentId, worktreeId)
    : (ensureDetectedAgentsForRepo(state, repo) ?? Promise.resolve([]))
}

/** Per-attempt project facts; older hosts retain their existing pre-create validation. */
export async function loadProjectLaunchContext(
  target: RuntimeClientTarget,
  repoId: string
): Promise<ProjectLaunchContext | undefined> {
  const capability = PREFLIGHT_PROJECT_LAUNCH_CONTEXT_RUNTIME_CAPABILITY
  let supported = false
  try {
    supported =
      target.kind === 'local'
        ? (await ensureLocalRuntimeCapabilities())?.includes(capability) === true
        : await runtimeEnvironmentSupportsCapability(target.environmentId, capability)
  } catch {
    // An unknown capability keeps the existing launch path.
  }
  return supported
    ? callRuntimeRpc<ProjectLaunchContext>(target, 'preflight.detectAgents', {
        project: { repo: `id:${repoId}` }
      })
    : undefined
}

/** IDs and the latest attempt outcome always describe the same target. */
export function readAgentInventoryForTarget(state: AppState, target: AgentDetectionTarget) {
  if (target.kind === 'local') {
    return state.readLocalAgentInventory(target.worktreeId)
  }
  const ids = readDetectedAgentsForTarget(state, target)
  if (target.kind !== 'runtime') {
    return { ids, state: state.remoteAgentInventoryOutcome(target.connectionId) }
  }
  const key = getRuntimeAgentInventoryKey(target.environmentId, target.worktreeId)
  const unsupported = state.runtimeAgentDetectionNeedsServerUpdate[key]
  return {
    ids,
    state: unsupported ? ('unsupported' as const) : state.runtimeAgentInventoryOutcome(key)
  }
}
export function readAgentInventoryForWorktree(state: AppState, worktreeId: string) {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target
    ? readAgentInventoryForTarget(state, target)
    : { ids: null, state: 'unresolved' as const }
}

/** Full paths to Orca's copies the workspace's host reported, for the launch builders; a local
 *  workspace running under WSL has none (Orca's copies live on this computer). */
export function readManagedAgentCommandsForWorktree(
  state: AppState,
  worktreeId: string | null | undefined
): ManagedAgentCommands | undefined {
  const target = detectionTargetForWorktree(state, worktreeId ?? null)
  if (!target || target.kind === 'ssh') {
    return undefined
  }
  if (target.kind === 'runtime') {
    return worktreeId && getConnectionIdFromState(state, worktreeId)
      ? undefined
      : readManagedAgentCommands(runtimeManagedAgentHost(target.environmentId))
  }
  const context = getLocalAgentPreflightContext(state, undefined, undefined, target.worktreeId)
  const runtime = context?.projectRuntime
  const inWsl =
    Boolean(context?.wslDistro || context?.wslDefault) ||
    (runtime !== undefined && (runtime.status !== 'resolved' || runtime.runtime.kind === 'wsl'))
  return inWsl ? undefined : readManagedAgentCommands(LOCAL_MANAGED_AGENT_HOST)
}

/** Orca's copy paths on a project's host before its workspace exists; a local project running
 *  under WSL (a launch platform other than this computer's) has none. */
export function readManagedAgentCommandsForRepo(
  repo: RepoHostFields,
  launchPlatform: NodeJS.Platform | null | undefined
): ManagedAgentCommands | undefined {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    return repo.connectionId
      ? undefined
      : readManagedAgentCommands(runtimeManagedAgentHost(host.environmentId))
  }
  return host?.kind === 'ssh' || launchPlatform !== getRendererAppPlatform()
    ? undefined
    : readManagedAgentCommands(LOCAL_MANAGED_AGENT_HOST)
}

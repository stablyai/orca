import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { PREFLIGHT_PROJECT_LAUNCH_CONTEXT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { ProjectLaunchContext } from '../../../shared/rpc-contract/preflight-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey,
  type AgentDetectionOwnerState
} from '@/hooks/useAgentDetectionTarget'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { getLocalAgentPreflightContext, localPreflightContextKey } from './local-preflight-context'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { TuiAgent } from '../../../shared/tui-agent'

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

export function detectionTargetForWorktree(
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
  const target = detectionTargetForRepo(repo)
  return target ? ensureDetectedAgentsForTarget(state, target) : null
}

/** This is the source ensureRepo actually probes, before any workspace exists. */
export function detectionTargetForRepo(repo: RepoHostFields): AgentDetectionTarget | undefined {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? undefined
    : host?.kind === 'ssh'
      ? { kind: 'ssh', connectionId: host.targetId }
      : { kind: 'local' }
}

/** Click-local fence; never evaluated from a store subscription. */
export function agentInventoryAttemptKey(
  state: AppState,
  target: AgentDetectionTarget | undefined
): string | null {
  if (!target) {
    return null
  }
  const context =
    target.kind === 'local'
      ? getLocalAgentPreflightContext(state, undefined, undefined, target.worktreeId)
      : undefined
  if (context?.projectRuntime && context.projectRuntime.status !== 'resolved') {
    return null
  }
  return JSON.stringify([
    target,
    target.kind === 'local' ? localPreflightContextKey(context) : null,
    target.kind === 'runtime'
      ? [
          getRuntimeEnvironmentRevision(target.environmentId),
          lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(target.environmentId))
            ?.runtimeId
        ]
      : null
  ])
}

/** A just-created workspace's agents; names it to its project's host while the new row hydrates. */
export function ensureDetectedAgentsForNewWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string,
  repo: RepoHostFields
): Promise<TuiAgent[]> {
  return ensureDetectedAgentsForTarget(
    state,
    detectionTargetForNewWorktree(state, worktreeId, repo)
  )
}

/** Bind reads to the same workspace/repo fallback that supplied the attempt. */
export function detectionTargetForNewWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string,
  repo: RepoHostFields
): AgentDetectionTarget {
  const target = detectionTargetForWorktree(state, worktreeId)
  if (target) {
    return target
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? { kind: 'runtime', environmentId: host.environmentId, worktreeId }
    : host?.kind === 'ssh'
      ? { kind: 'ssh', connectionId: host.targetId }
      : { kind: 'local' }
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

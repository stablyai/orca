import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  getGlobalWindowsExecutionRuntimeContext,
  getLocalProjectExecutionRuntimeContext
} from '@/runtime/hosts/preflight/local-preflight-context'
import type { LocalProjectRuntimeWslContext } from '@/runtime/hosts/preflight/local-preflight-context-cache'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getProjectAgentSkillRuntime,
  getProjectAgentSkillTerminalShellOverride,
  getProjectSkillDiscoveryTarget,
  getProjectSkillInstallDisabledReason
} from './project-skill-runtime'
import type { ProjectAgentSkillRuntime } from './project-skill-runtime'
import { resolveBundledSkillTarget } from './bundled-skill-target'
import type { BundledSkillTarget } from './bundled-skill-target'
import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../../../shared/skills/discovery/skills'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type ProjectSkillRuntime = {
  projectRuntime?: ProjectExecutionRuntimeResolution
  discoveryTarget?: SkillDiscoveryTarget
  discoveryRuntimeTarget: RuntimeClientTarget | null
  managerRuntimeTarget: RuntimeClientTarget | null
  agentRuntime?: ProjectAgentSkillRuntime
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  terminalShellOverride?: string
  installDisabledReason: string | null
  canUseSkillFreshness: boolean
  /** Where Update skills plans Orca's skills; null while that host is unknown. */
  bundledSkillTarget: BundledSkillTarget | null
}

type ProjectSkillRuntimeState = Parameters<typeof getLocalProjectExecutionRuntimeContext>[0]

type ProjectSkillRuntimeInput = {
  state: ProjectSkillRuntimeState
  /** The active workspace's serving host. */
  activeWorkspaceHostId: string | null
  /** The focused runtime owner; null while unresolved. */
  runtimeTarget: RuntimeClientTarget | null
  currentPlatform: NodeJS.Platform
  wslContext: LocalProjectRuntimeWslContext
  /** A host the caller picked; the active workspace counts only when it lives there. */
  hostId?: ExecutionHostId
  /** On a paired web client, the server its `local` host is. */
  webClientEnvironmentId?: string | null
}

const LOCAL_RUNTIME_TARGET = { kind: 'local' } as const

/** Whether setup surfaces show the plan's pill: this machine or a paired host, not WSL yet. */
function shouldUseSkillFreshness(
  runtimeTarget: RuntimeClientTarget | null,
  agentRuntime?: ProjectAgentSkillRuntime
): boolean {
  return (
    runtimeTarget?.kind === 'environment' ||
    (runtimeTarget?.kind === 'local' && agentRuntime?.runtime !== 'wsl')
  )
}

/** Keeps only a WSL-targeting resolution; a windows-host one is the same as having none here. */
function wslOnly(
  resolution: ProjectExecutionRuntimeResolution | undefined
): ProjectExecutionRuntimeResolution | undefined {
  if (!resolution) {
    return undefined
  }
  const targetsWsl = resolution.status === 'repair-required' || resolution.runtime.kind === 'wsl'
  return targetsWsl ? resolution : undefined
}

function runtimeTargetForHost(
  hostId: ExecutionHostId,
  webClientEnvironmentId: string | null | undefined
): RuntimeClientTarget {
  const host = parseExecutionHostId(hostId)
  return runtimeTargetForOwnerEnvironment(
    host?.kind === 'runtime' ? host.environmentId : (webClientEnvironmentId ?? null)
  )
}

/** A picked host resolves like nothing is open when the active project lives elsewhere; an unresolved owner stays pending. */
function activeProjectIsElsewhere(
  state: ProjectSkillRuntimeState,
  activeWorkspaceHostId: string | null,
  hostId: ExecutionHostId
): boolean {
  if (state.activeWorktreeId) {
    return activeWorkspaceHostId !== null && activeWorkspaceHostId !== hostId
  }
  const repo = state.activeRepoId
    ? state.repos.find((candidate) => candidate.id === state.activeRepoId)
    : undefined
  return repo !== undefined && getRepoExecutionHostId(repo) !== hostId
}

export function resolveProjectSkillRuntime(input: ProjectSkillRuntimeInput): ProjectSkillRuntime {
  const { activeWorkspaceHostId, currentPlatform, wslContext, hostId } = input
  const runtimeTarget =
    hostId === undefined
      ? input.runtimeTarget
      : runtimeTargetForHost(hostId, input.webClientEnvironmentId)
  const state =
    hostId !== undefined && activeProjectIsElsewhere(input.state, activeWorkspaceHostId, hostId)
      ? { ...input.state, activeRepoId: null, activeWorktreeId: null }
      : input.state
  const ownerRuntimeTarget =
    state.activeWorktreeId && activeWorkspaceHostId === LOCAL_EXECUTION_HOST_ID
      ? LOCAL_RUNTIME_TARGET
      : runtimeTarget
  const localAuthority =
    ownerRuntimeTarget?.kind === 'local' &&
    (!state.activeWorktreeId || activeWorkspaceHostId === LOCAL_EXECUTION_HOST_ID)
  const projectRuntime = localAuthority
    ? (getLocalProjectExecutionRuntimeContext(state, undefined, currentPlatform, wslContext) ??
      // Global WSL is the only no-project default that changes the install target (#12103).
      wslOnly(
        getGlobalWindowsExecutionRuntimeContext(state, undefined, currentPlatform, wslContext)
      ))
    : undefined
  const bundledSkillTarget = resolveBundledSkillTarget(
    ownerRuntimeTarget,
    projectRuntime,
    state.activeWorktreeId ? activeWorkspaceHostId : undefined
  )
  const discoveryRuntimeTarget =
    bundledSkillTarget?.kind === 'ssh'
      ? null
      : (bundledSkillTarget ?? (localAuthority && projectRuntime ? ownerRuntimeTarget : null))
  if (!projectRuntime) {
    return {
      discoveryRuntimeTarget,
      managerRuntimeTarget: runtimeTarget,
      installDisabledReason: null,
      canUseSkillFreshness: shouldUseSkillFreshness(discoveryRuntimeTarget),
      bundledSkillTarget
    }
  }

  const agentRuntime = getProjectAgentSkillRuntime(projectRuntime, currentPlatform)
  return {
    projectRuntime,
    discoveryRuntimeTarget,
    managerRuntimeTarget: runtimeTarget,
    discoveryTarget: getProjectSkillDiscoveryTarget(projectRuntime),
    agentRuntime,
    // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
    terminalShellOverride: getProjectAgentSkillTerminalShellOverride(
      currentPlatform,
      state.settings,
      agentRuntime
    ),
    installDisabledReason: getProjectSkillInstallDisabledReason(projectRuntime),
    canUseSkillFreshness: shouldUseSkillFreshness(discoveryRuntimeTarget, agentRuntime),
    bundledSkillTarget
  }
}

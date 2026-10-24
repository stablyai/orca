import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  getGlobalWindowsExecutionRuntimeContext,
  getLocalProjectExecutionRuntimeContext
} from '@/lib/local-preflight-context'
import {
  getProjectAgentSkillRuntime,
  getProjectAgentSkillTerminalShellOverride,
  getProjectSkillDiscoveryTarget,
  getProjectSkillInstallDisabledReason,
  type ProjectAgentSkillRuntime
} from '@/lib/project-skill-runtime'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import {
  resolveBundledSkillTarget,
  servingExecutionHostId,
  type BundledSkillTarget
} from '@/lib/bundled-skill-target'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type ActiveProjectSkillRuntime = {
  projectRuntime?: ProjectExecutionRuntimeResolution
  discoveryTarget?: SkillDiscoveryTarget
  discoveryRuntimeTarget: RuntimeClientTarget | null
  agentRuntime?: ProjectAgentSkillRuntime
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  terminalShellOverride?: string
  installDisabledReason: string | null
  canUseSkillFreshness: boolean
  /** Where Update skills plans Orca's skills; null while that host is unknown. */
  bundledSkillTarget: BundledSkillTarget | null
}

const LOCAL_RUNTIME_TARGET = { kind: 'local' } as const

/** Whether setup surfaces show the plan's pill: this machine or a paired host, not WSL yet. */
export function shouldUseSkillFreshness(
  runtimeTarget: RuntimeClientTarget | null,
  agentRuntime?: ProjectAgentSkillRuntime
): boolean {
  return (
    runtimeTarget?.kind === 'environment' ||
    (runtimeTarget?.kind === 'local' && agentRuntime?.runtime !== 'wsl')
  )
}

export function hasLocalSkillRuntimeAuthority(runtimeTarget: RuntimeClientTarget | null): boolean {
  return runtimeTarget?.kind === 'local'
}

// Why: on Windows the runtime resolution is rebuilt from scratch on every
// worktree-store change, so a same-runtime result still arrives with a fresh
// identity. Downstream skill discovery keys effects off `discoveryTarget`, so
// that churn would re-run a scan (and blink its loading state) per store update.
// Serializing the whole value (rather than picking fields) keeps the comparison
// honest if the resolution grows a field the runtime cache keys do not encode.
function activeProjectSkillRuntimeIdentity(runtime: ActiveProjectSkillRuntime): string {
  return JSON.stringify(runtime)
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

export function useActiveProjectSkillRuntime(): ActiveProjectSkillRuntime {
  const runtimeState = useAppStore(
    useShallow((state) => ({
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      projects: state.projects,
      repos: state.repos,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      settings: state.settings,
      worktreesByRepo: selectWorktreesByRepo(state)
    }))
  )
  const activeWorkspaceHostId = useAppStore((state) =>
    servingExecutionHostId(
      getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId),
      state.runtimeEnvironments
    )
  )
  const currentPlatform = getCurrentPlatform()
  const windowsCapabilities = useWindowsTerminalCapabilities(currentPlatform === 'win32')
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()

  const resolved = useMemo(() => {
    const wslContext = {
      wslAvailable: windowsCapabilities.isLoading ? undefined : windowsCapabilities.wslAvailable,
      availableWslDistros: windowsCapabilities.isLoading ? null : windowsCapabilities.wslDistros
    }
    const ownerRuntimeTarget =
      runtimeState.activeWorktreeId && activeWorkspaceHostId === LOCAL_EXECUTION_HOST_ID
        ? LOCAL_RUNTIME_TARGET
        : runtimeTarget
    const localAuthority =
      hasLocalSkillRuntimeAuthority(ownerRuntimeTarget) &&
      (!runtimeState.activeWorktreeId || activeWorkspaceHostId === LOCAL_EXECUTION_HOST_ID)
    const projectRuntime = localAuthority
      ? (getLocalProjectExecutionRuntimeContext(
          runtimeState,
          undefined,
          currentPlatform,
          wslContext
        ) ??
        // Global WSL is the only no-project default that changes the install target (#12103).
        wslOnly(
          getGlobalWindowsExecutionRuntimeContext(
            runtimeState,
            undefined,
            currentPlatform,
            wslContext
          )
        ))
      : undefined
    const bundledSkillTarget = resolveBundledSkillTarget(
      ownerRuntimeTarget,
      projectRuntime,
      runtimeState.activeWorktreeId ? activeWorkspaceHostId : undefined
    )
    const discoveryRuntimeTarget =
      bundledSkillTarget?.kind === 'ssh'
        ? null
        : (bundledSkillTarget ?? (localAuthority && projectRuntime ? ownerRuntimeTarget : null))
    if (!projectRuntime) {
      return {
        discoveryRuntimeTarget,
        installDisabledReason: null,
        canUseSkillFreshness: shouldUseSkillFreshness(discoveryRuntimeTarget),
        bundledSkillTarget
      }
    }

    const agentRuntime = getProjectAgentSkillRuntime(projectRuntime, currentPlatform)
    return {
      projectRuntime,
      discoveryRuntimeTarget,
      discoveryTarget: getProjectSkillDiscoveryTarget(projectRuntime),
      agentRuntime,
      // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
      terminalShellOverride: getProjectAgentSkillTerminalShellOverride(
        currentPlatform,
        runtimeState.settings,
        agentRuntime
      ),
      installDisabledReason: getProjectSkillInstallDisabledReason(projectRuntime),
      canUseSkillFreshness: shouldUseSkillFreshness(discoveryRuntimeTarget, agentRuntime),
      bundledSkillTarget
    }
  }, [activeWorkspaceHostId, currentPlatform, runtimeState, runtimeTarget, windowsCapabilities])

  // Content-equal runtimes keep one reference so effect keys do not thrash.
  // Adjust during render (not a ref write) when serialized identity changes.
  const [stable, setStable] = useState(resolved)
  const stableIdentity = activeProjectSkillRuntimeIdentity(stable)
  const resolvedIdentity = activeProjectSkillRuntimeIdentity(resolved)
  if (stableIdentity !== resolvedIdentity) {
    setStable(resolved)
  }
  return stableIdentity === resolvedIdentity ? stable : resolved
}

function getCurrentPlatform(): NodeJS.Platform {
  const platform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (platform) {
    return platform
  }

  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  return 'linux'
}

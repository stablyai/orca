import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../shared/skills'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getGlobalWindowsExecutionRuntimeContext,
  getLocalProjectExecutionRuntimeContext
} from '@/lib/local-preflight-context'
import {
  getHostAgentSkillRuntime,
  getProjectAgentSkillRuntime,
  getProjectAgentSkillTerminalShellOverride,
  getProjectSkillDiscoveryTarget,
  getProjectSkillInstallDisabledReason,
  type ProjectAgentSkillRuntime
} from '@/lib/project-skill-runtime'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { useWindowsTerminalCapabilityOwnerKey } from './useWindowsTerminalCapabilityOwnerKey'

type ActiveProjectSkillRuntime = {
  projectRuntime?: ProjectExecutionRuntimeResolution
  discoveryTarget?: SkillDiscoveryTarget
  agentRuntime?: ProjectAgentSkillRuntime
  terminalShellOverride?: string
  installDisabledReason: string | null
  canUseLocalSkillFreshness: boolean
  executionHostPlatform?: NodeJS.Platform
}

export function shouldUseLocalSkillFreshness(
  runtimeTarget: RuntimeClientTarget | null,
  agentRuntime?: ProjectAgentSkillRuntime
): boolean {
  return runtimeTarget?.kind === 'local' && agentRuntime?.runtime !== 'wsl'
}

export function hasLocalSkillRuntimeAuthority(runtimeTarget: RuntimeClientTarget | null): boolean {
  return runtimeTarget?.kind === 'local'
}

export function resolveSkillExecutionHostPlatform(args: {
  viewerPlatform: NodeJS.Platform
  runtimeTarget: RuntimeClientTarget | null
  executionHostPlatform?: NodeJS.Platform
  isWebClient: boolean
}): NodeJS.Platform | undefined {
  if (!args.runtimeTarget) {
    return undefined
  }
  if (args.runtimeTarget?.kind === 'environment') {
    return args.executionHostPlatform
  }
  if (args.isWebClient) {
    return args.executionHostPlatform
  }
  return args.viewerPlatform
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
      settings: state.settings,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const viewerPlatform = getCurrentPlatform()
  const isWebClient = isWebClientLocation()
  const executionHostEnvironmentId = useAppStore((state) =>
    runtimeTarget?.kind === 'environment'
      ? runtimeTarget.environmentId
      : isWebClient && runtimeTarget?.kind === 'local'
        ? state.runtimeEnvironments[0]?.id
        : undefined
  )
  const executionHostStatus = useAppStore((state) =>
    executionHostEnvironmentId
      ? state.runtimeStatusByEnvironmentId.get(executionHostEnvironmentId)?.status
      : undefined
  )
  const executionHostPlatform = executionHostStatus?.hostPlatform
  const currentPlatform = resolveSkillExecutionHostPlatform({
    viewerPlatform,
    runtimeTarget,
    executionHostPlatform,
    isWebClient
  })
  const windowsCapabilityOwnerKey = useWindowsTerminalCapabilityOwnerKey(
    runtimeTarget?.kind === 'environment' ? runtimeTarget.environmentId : undefined
  )
  const hasProjectRuntimeAuthority = !isWebClient && hasLocalSkillRuntimeAuthority(runtimeTarget)
  const windowsCapabilities = useWindowsTerminalCapabilities(
    currentPlatform === 'win32' && hasProjectRuntimeAuthority,
    false,
    windowsCapabilityOwnerKey,
    isWebClient ? { kind: 'local' } : (runtimeTarget ?? { kind: 'local' })
  )

  const resolved = useMemo(() => {
    const wslContext = {
      wslAvailable: windowsCapabilities.isLoading ? undefined : windowsCapabilities.wslAvailable,
      availableWslDistros: windowsCapabilities.isLoading ? null : windowsCapabilities.wslDistros
    }
    const projectRuntime =
      currentPlatform && hasProjectRuntimeAuthority
        ? (getLocalProjectExecutionRuntimeContext(
            runtimeState,
            undefined,
            currentPlatform,
            wslContext
          ) ??
          // Global WSL is the only no-project default that changes the install target (#12103).
          (hasProjectRuntimeAuthority
            ? wslOnly(
                getGlobalWindowsExecutionRuntimeContext(
                  runtimeState,
                  undefined,
                  currentPlatform,
                  wslContext
                )
              )
            : undefined))
        : undefined
    if (!projectRuntime || !currentPlatform) {
      // Why: buildSkillCommandForRuntime still builds a Windows host command
      // without a project runtime, so the terminal has to match that shell.
      const terminalShellOverride =
        currentPlatform && hasProjectRuntimeAuthority
          ? getProjectAgentSkillTerminalShellOverride(
              currentPlatform,
              runtimeState.settings,
              undefined
            )
          : undefined
      const canUseLocalSkillFreshness = shouldUseLocalSkillFreshness(runtimeTarget)
      return {
        installDisabledReason: null,
        agentRuntime:
          runtimeTarget?.kind !== 'local' || isWebClient
            ? {
                ...getHostAgentSkillRuntime(
                  currentPlatform,
                  executionHostStatus?.terminalWindowsShell,
                  executionHostEnvironmentId
                ),
                terminalWindowsShell: executionHostStatus?.terminalWindowsShell
              }
            : getHostAgentSkillRuntime(currentPlatform, undefined, null),
        terminalShellOverride,
        canUseLocalSkillFreshness,
        executionHostPlatform: currentPlatform
      }
    }

    const agentRuntime = getProjectAgentSkillRuntime(projectRuntime, currentPlatform)
    return {
      projectRuntime,
      discoveryTarget: getProjectSkillDiscoveryTarget(projectRuntime),
      agentRuntime,
      terminalShellOverride: getProjectAgentSkillTerminalShellOverride(
        currentPlatform,
        runtimeState.settings,
        agentRuntime
      ),
      installDisabledReason: getProjectSkillInstallDisabledReason(projectRuntime),
      canUseLocalSkillFreshness: shouldUseLocalSkillFreshness(runtimeTarget, agentRuntime),
      executionHostPlatform: currentPlatform
    }
  }, [
    currentPlatform,
    executionHostStatus?.terminalWindowsShell,
    executionHostEnvironmentId,
    hasProjectRuntimeAuthority,
    isWebClient,
    runtimeState,
    runtimeTarget,
    windowsCapabilities
  ])

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

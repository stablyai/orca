import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { translate } from '@/i18n/i18n'
import { getProjectAgentSkillTerminalShellOverride } from '@/lib/project-skill-runtime'
import type { LocalAgentRuntime } from '../settings/CliSkillRuntimeSetup'

const LOCAL_DISMISS_STORAGE_KEY_PREFIX = 'orca.linearTicketsSkill.setupDismissed'

export type LinearAgentSkillPromptSettings = Pick<
  GlobalSettings,
  | 'localAgentRuntime'
  | 'localAgentWslDistro'
  | 'terminalWindowsShell'
  | 'activeRuntimeEnvironmentId'
>

export function getCurrentPlatform(): NodeJS.Platform {
  const platform = window.api?.platform?.get?.()?.platform
  return platform === 'win32' || platform === 'linux' ? platform : 'darwin'
}

export function resolveLinearSkillCommandPlatform(args: {
  explicitPlatform?: NodeJS.Platform
  executionHostPlatform?: NodeJS.Platform
  remote: boolean
  webClient: boolean
  viewerPlatform: NodeJS.Platform
}): NodeJS.Platform | undefined {
  return (
    args.explicitPlatform ??
    (args.remote || args.webClient ? args.executionHostPlatform : args.viewerPlatform)
  )
}

export function getLinearPromptAgentRuntime(
  settings: LinearAgentSkillPromptSettings | null | undefined,
  currentPlatform: NodeJS.Platform | undefined,
  remote: boolean,
  projectRuntime?: ProjectExecutionRuntimeResolution,
  executionHostRuntime?: LocalAgentRuntime
): LocalAgentRuntime {
  const resolvedProjectRuntime = getProjectAgentRuntime(projectRuntime, currentPlatform)
  if (resolvedProjectRuntime) {
    return resolvedProjectRuntime
  }
  if (executionHostRuntime) {
    return executionHostRuntime
  }
  if (remote) {
    // Why: this prompt opens a local terminal; remote environments need their
    // own setup even when local agent discovery prefers WSL.
    return {
      runtime: 'host',
      hostPlatform: currentPlatform,
      label: currentPlatform === 'win32' ? 'Windows' : 'This device'
    }
  }
  const selectedRuntime = settings?.localAgentRuntime ?? 'host'
  if (currentPlatform === 'win32' && selectedRuntime === 'wsl') {
    const selectedDistro = settings?.localAgentWslDistro?.trim() || null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      hostPlatform: 'win32',
      label: selectedDistro
        ? `WSL ${selectedDistro}`
        : translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.wslLabel', 'WSL default')
    }
  }
  return {
    runtime: 'host',
    hostPlatform: currentPlatform,
    label: currentPlatform === 'win32' ? 'Windows' : 'This device'
  }
}

function getProjectAgentRuntime(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  currentPlatform: NodeJS.Platform | undefined
): LocalAgentRuntime | null {
  if (!projectRuntime) {
    return null
  }
  if (projectRuntime.status === 'repair-required') {
    // Why: a repair state still owns the project runtime; falling back to host
    // here would mix skill setup state between Windows and WSL.
    return getWslAgentRuntime(projectRuntime.repair.preferredRuntime.distro)
  }
  if (projectRuntime.runtime.kind === 'wsl') {
    return getWslAgentRuntime(projectRuntime.runtime.distro)
  }
  return {
    runtime: 'host',
    hostPlatform: currentPlatform,
    label: currentPlatform === 'win32' ? 'Windows' : 'This device'
  }
}

function getWslAgentRuntime(distro: string | null): LocalAgentRuntime {
  return {
    runtime: 'wsl',
    wslDistro: distro,
    hostPlatform: 'win32',
    label: distro
      ? `WSL ${distro}`
      : translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.wslLabel', 'WSL default')
  }
}

export function getLinearPromptTerminalShellOverride(
  currentPlatform: NodeJS.Platform | undefined,
  settings: LinearAgentSkillPromptSettings | null | undefined,
  runtime: LocalAgentRuntime
): string | undefined {
  if (!currentPlatform) {
    return undefined
  }
  return getProjectAgentSkillTerminalShellOverride(currentPlatform, settings, runtime)
}

export function getLinearPromptSetupCheckIdentity(args: {
  remote: boolean
  runtime: LocalAgentRuntime
  projectRuntime?: ProjectExecutionRuntimeResolution
  activeRuntimeEnvironmentId?: string | null
}): string {
  return JSON.stringify({
    remote: args.remote,
    runtime: args.runtime.runtime,
    wslDistro: args.runtime.wslDistro ?? null,
    hostPlatform: args.runtime.hostPlatform ?? null,
    projectRuntime: getProjectRuntimeIdentity(args.projectRuntime),
    activeRuntimeEnvironmentId: args.activeRuntimeEnvironmentId ?? null
  })
}

export function getLinearPromptSkillDiscoveryTarget(
  runtime: LocalAgentRuntime,
  projectRuntime?: ProjectExecutionRuntimeResolution
): SkillDiscoveryTarget | undefined {
  if (projectRuntime) {
    return { projectRuntime }
  }
  return runtime.runtime === 'wsl' ? { runtime: 'wsl', wslDistro: runtime.wslDistro } : undefined
}

export function getLocalDismissStorageKey(runtime: LocalAgentRuntime): string {
  if (runtime.runtime !== 'wsl') {
    return `${LOCAL_DISMISS_STORAGE_KEY_PREFIX}.host`
  }
  return `${LOCAL_DISMISS_STORAGE_KEY_PREFIX}.wsl.${runtime.wslDistro?.trim() || 'default'}`
}

export function readLocalDismissed(storageKey: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return localStorage.getItem(storageKey) === '1'
}

function getProjectRuntimeIdentity(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | null {
  if (!projectRuntime) {
    return null
  }
  return projectRuntime.status === 'resolved'
    ? projectRuntime.runtime.cacheKey
    : projectRuntime.repair.cacheKey
}

import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import type { LocalAgentRuntime } from '../settings/CliSkillRuntimeSetup'

const LOCAL_DISMISS_STORAGE_KEY_PREFIX = 'orca.linearTicketsSkill.setupDismissed'

export type LinearAgentSkillPromptSettings = Pick<
  GlobalSettings,
  | 'localAgentRuntime'
  | 'localAgentWslDistro'
  | 'terminalWindowsShell'
  | 'terminalWindowsWslDistro'
  | 'activeRuntimeEnvironmentId'
>

export function getCurrentPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  return navigator.userAgent.includes('Linux') ? 'linux' : 'darwin'
}

export function getLinearPromptAgentRuntime(
  settings: LinearAgentSkillPromptSettings | null | undefined,
  currentPlatform: NodeJS.Platform,
  remote: boolean
): LocalAgentRuntime {
  if (remote) {
    // Why: this prompt opens a local terminal; remote environments need their
    // own setup even when local agent discovery prefers WSL.
    return {
      runtime: 'host',
      label: currentPlatform === 'win32' ? 'Windows' : 'This device'
    }
  }
  const selectedRuntime =
    settings?.localAgentRuntime ?? (settings?.terminalWindowsShell === 'wsl.exe' ? 'wsl' : 'host')
  if (currentPlatform === 'win32' && selectedRuntime === 'wsl') {
    const selectedDistro =
      settings?.localAgentWslDistro?.trim() || settings?.terminalWindowsWslDistro?.trim() || null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      label: selectedDistro
        ? `WSL ${selectedDistro}`
        : translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.wslLabel', 'WSL default')
    }
  }
  return {
    runtime: 'host',
    label: currentPlatform === 'win32' ? 'Windows' : 'This device'
  }
}

export function getLinearPromptTerminalShellOverride(
  currentPlatform: NodeJS.Platform,
  settings: LinearAgentSkillPromptSettings | null | undefined,
  runtime: LocalAgentRuntime
): string | undefined {
  if (currentPlatform !== 'win32') {
    return undefined
  }
  if (runtime.runtime === 'wsl') {
    return 'powershell.exe'
  }
  return settings?.terminalWindowsShell?.toLowerCase() === 'wsl.exe' ? 'powershell.exe' : undefined
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

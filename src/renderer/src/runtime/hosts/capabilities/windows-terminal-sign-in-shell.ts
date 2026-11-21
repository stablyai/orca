import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { resolveHostAgentStartupShell } from '../../../../../shared/shell/launch/windows-terminal-shell'
import {
  getProbedLocalGitBashAvailability,
  useLocalWindowsTerminalCapabilities
} from './windows-terminal-capabilities'

/** Probe this machine before a local sign-in command treats a missing Git Bash as PowerShell. */
export function useBashProbe(local: boolean): void {
  useLocalWindowsTerminalCapabilities(
    local && getRendererAppPlatform() === 'win32' && !isWebClientLocation()
  )
}

/** Sign-in startup family, including the missing-Git-Bash PowerShell fallback. */
export function signInShell(args: {
  platform: NodeJS.Platform | null | undefined
  isRemote: boolean
  hostTerminalWindowsShell?: string | null
}): ReturnType<typeof resolveHostAgentStartupShell> | 'posix' | null {
  if (!args.platform) {
    return null
  }
  return (
    resolveHostAgentStartupShell({
      platform: args.platform,
      isRemote: args.isRemote,
      hostTerminalWindowsShell: args.hostTerminalWindowsShell,
      gitBashAvailable: args.isRemote ? undefined : getProbedLocalGitBashAvailability()
    }) ?? (args.platform === 'win32' ? null : 'posix')
  )
}

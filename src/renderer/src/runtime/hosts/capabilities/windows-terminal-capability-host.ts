import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

// A failed read builds a new all-false object. Reuse checks the shared placeholder by identity.
export function capabilitiesToCache(
  capabilities: WindowsTerminalCapabilities,
  gitBashProbed: boolean,
  unavailable: WindowsTerminalCapabilities
): WindowsTerminalCapabilities {
  if (
    gitBashProbed ||
    capabilities.hostPlatform ||
    capabilities.wslAvailable ||
    capabilities.pwshAvailable ||
    capabilities.gitBashAvailable ||
    capabilities.wslDistros.length > 0
  ) {
    return capabilities
  }
  return unavailable
}

export function isWindowsTerminalCapabilityHost(args: {
  isWindowsRenderer: boolean
  isWebClient: boolean
  target: RuntimeClientTarget
  hostPlatform: NodeJS.Platform | null
}): boolean {
  return (
    args.hostPlatform === 'win32' ||
    (!args.isWebClient && args.target.kind === 'local' && args.isWindowsRenderer)
  )
}

import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WindowsTerminalCapabilities } from './windows-terminal-capability-cache'

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

export function freshCachedCapabilities(
  cached: { capabilities: WindowsTerminalCapabilities; loadedAt: number } | undefined,
  unavailable: WindowsTerminalCapabilities,
  now: number,
  ttlMs: number,
  force?: boolean
): WindowsTerminalCapabilities | undefined {
  if (!cached || cached.capabilities === unavailable || force || now - cached.loadedAt >= ttlMs) {
    return undefined
  }
  return cached.capabilities
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

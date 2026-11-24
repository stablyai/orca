import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

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

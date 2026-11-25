export function shouldShowWindowsShellMenu(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  hostPlatform: NodeJS.Platform | null
  isWindowsClient: boolean
  worktreeHasRemoteConnection: boolean
}): boolean {
  // Offer Windows shells only after the execution host is known Windows, independent of client platform.
  const runtimeHostIsNotKnownWindows =
    Boolean(args.activeRuntimeEnvironmentId?.trim()) && args.hostPlatform !== 'win32'
  if (args.worktreeHasRemoteConnection) {
    return args.hostPlatform === 'win32'
  }
  return (args.isWindowsClient || args.hostPlatform === 'win32') && !runtimeHostIsNotKnownWindows
}

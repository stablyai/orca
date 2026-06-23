export function shouldShowWindowsShellMenu(args: {
  activeRuntimeEnvironmentId: string | null | undefined
  hostPlatform: NodeJS.Platform | null
  isWindowsClient: boolean
  worktreeHasRemoteConnection: boolean
}): boolean {
  // Why: runtime terminals execute on the runtime host. Until that host is known
  // to be Windows, local Windows shell choices would advertise the wrong target.
  const runtimeHostIsNotKnownWindows =
    Boolean(args.activeRuntimeEnvironmentId?.trim()) && args.hostPlatform !== 'win32'
  return (
    (args.isWindowsClient || args.hostPlatform === 'win32') &&
    !args.worktreeHasRemoteConnection &&
    !runtimeHostIsNotKnownWindows
  )
}

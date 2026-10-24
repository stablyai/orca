/** The execution host supplies this; browser caches without a host use exact identity. */
export function agentPermissionHostPlatform(): NodeJS.Platform | undefined {
  return typeof process !== 'undefined' ? process.platform : undefined
}

export function permissionEnvNameMatches(
  left: string,
  right: string,
  platform: NodeJS.Platform | null | undefined
): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

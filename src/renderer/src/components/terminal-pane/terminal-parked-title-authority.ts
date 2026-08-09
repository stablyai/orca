export function parkedTerminalLeafDrivesTabTitle(args: {
  activeLeafId: string | null | undefined
  leafId: string
  capturedAuthority: boolean
}): boolean {
  return args.activeLeafId ? args.activeLeafId === args.leafId : args.capturedAuthority
}

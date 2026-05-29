export function shouldCancelVirtualizedScrollOffsetRestore(args: {
  hasDirectScrollInput?: () => boolean
  restoring: boolean
}): boolean {
  return args.restoring && args.hasDirectScrollInput?.() === true
}

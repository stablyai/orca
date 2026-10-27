/** Creation intent belongs to this call, never to persisted agent provenance. */
export function shouldSeedWorktreePrimaryTerminal(args: {
  hasPrimarySurface: boolean
  callerProvidesSurface: boolean
  startupNeedsTerminal?: boolean
  issueCommandNeedsTerminal?: boolean
}): boolean {
  return (
    !args.hasPrimarySurface &&
    (!args.callerProvidesSurface ||
      args.startupNeedsTerminal === true ||
      args.issueCommandNeedsTerminal === true)
  )
}

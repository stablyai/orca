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

/** Background agent creates leave their first surface to the caller; activated ones still get a shell. */
export function backgroundAgentCreateLeavesSurface(args: {
  createdWithAgent?: unknown
  request: { activate?: boolean; runHooks?: boolean }
}): boolean {
  return (
    args.createdWithAgent !== undefined &&
    args.request.activate !== true &&
    args.request.runHooks !== true
  )
}

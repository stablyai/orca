export function buildCodexRestartNoticeKey(args: {
  previousAccountLabel: string
  nextAccountLabel: string
  homeRouteChanged?: true
}): string {
  return `${args.homeRouteChanged === true ? 'route' : 'account'}\u0000${args.previousAccountLabel}\u0000${args.nextAccountLabel}`
}

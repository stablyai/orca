export function buildCodexRestartNoticeKey(args: {
  previousAccountLabel: string
  nextAccountLabel: string
}): string {
  return `${args.previousAccountLabel}\u0000${args.nextAccountLabel}`
}

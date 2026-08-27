export function shouldPollChromiumErrorPage(args: {
  isActive: boolean
  loading: boolean
}): boolean {
  return args.isActive && args.loading
}

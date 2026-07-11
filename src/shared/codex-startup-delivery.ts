export type StartupCommandDelivery = 'fast' | 'shell-ready'

export function shouldUseShellReadyStartupDelivery(args: {
  command?: string | null | undefined
  startupCommandDelivery?: StartupCommandDelivery
}): boolean {
  // Why: Codex has no native draft-prefill flag. Only startup plans carrying
  // positional PROMPT explicitly opt in after the shell startup files run.
  void args.command
  return args.startupCommandDelivery === 'shell-ready'
}

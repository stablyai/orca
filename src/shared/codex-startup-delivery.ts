export type StartupCommandDelivery = 'fast' | 'shell-ready'

/**
 * Shell-ready delivery is opted in explicitly by the startup plan (e.g. Codex
 * positional PROMPT on argv). Codex has no native draft-prefill flag — earlier
 * `--prefill` detection was a myth and must not force shell-ready.
 */
export function shouldUseShellReadyStartupDelivery(args: {
  command?: string | null | undefined
  startupCommandDelivery?: StartupCommandDelivery
}): boolean {
  void args.command
  return args.startupCommandDelivery === 'shell-ready'
}

/** A fresh host-authority launch overrides args only when the caller asked; the client's resolved launchConfig would pin the host to this client's permission settings. Resume replays the recorded recipe. */
export function webRuntimeAgentArgsOverride(args: {
  agentArgs?: string | null
  agentSessionKind?: string
  launchConfig?: { agentArgs: string }
}): string | null | undefined {
  if (args.agentArgs !== undefined) {
    return args.agentArgs
  }
  return args.agentSessionKind === 'resume' ? args.launchConfig?.agentArgs : undefined
}

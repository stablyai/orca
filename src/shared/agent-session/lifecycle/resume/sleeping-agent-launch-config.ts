export type SleepingAgentLaunchConfig = {
  agentCommand?: string
  commandProvenance?: 'authored' | 'generated'
  authoredCommand?: string
  selectedExecutable?: string
  agentArgs: string
  agentEnv: Record<string, string>
  ompResumeFilePath?: string
}

export function buildSleepingAgentLaunchConfig(args: {
  commandProvenance?: SleepingAgentLaunchConfig['commandProvenance']
  authoredCommand?: string
  selectedExecutable?: string
  agentCommand?: string | null
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  ompResumeFilePath?: string | null
}): SleepingAgentLaunchConfig {
  return {
    ...(args.agentCommand?.trim() ? { agentCommand: args.agentCommand } : {}),
    ...(args.commandProvenance ? { commandProvenance: args.commandProvenance } : {}),
    ...(args.authoredCommand ? { authoredCommand: args.authoredCommand } : {}),
    ...(args.selectedExecutable ? { selectedExecutable: args.selectedExecutable } : {}),
    agentArgs: args.agentArgs ?? '',
    // Startup env may contain prompt/pane transport; persist only Orca-managed launch inputs.
    agentEnv: args.agentEnv ? { ...args.agentEnv } : {},
    ...(args.ompResumeFilePath?.trim() ? { ompResumeFilePath: args.ompResumeFilePath.trim() } : {})
  }
}

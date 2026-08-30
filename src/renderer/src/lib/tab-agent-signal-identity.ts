import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import type { TuiAgent } from '../../../shared/tui-agent'

export function resolveSignalAgentForLaunchOwner(
  signalAgent: TuiAgent | null | undefined,
  launchAgent: TuiAgent | null
): TuiAgent | null {
  if (!signalAgent) {
    return null
  }
  return (resolveCompatibleAgentTypeForOwner(signalAgent, launchAgent) ?? signalAgent) as TuiAgent
}

export function resolveCommandAgentEvidence(args: {
  agent?: TuiAgent | null
  trusted?: boolean
  titleAgent: TuiAgent | null
  owner: TuiAgent | null
}): [TuiAgent | null, TuiAgent | null] {
  const agent = resolveSignalAgentForLaunchOwner(args.agent, args.owner)
  return [
    args.trusted === true ? agent : null,
    args.trusted === false && !args.titleAgent ? agent : null
  ]
}

export function resolveCommandAwareTabAgent(args: {
  liveFocused: TuiAgent | null
  process: TuiAgent | null
  command?: TuiAgent | null
  commandTrusted?: boolean
  title: TuiAgent | null
  owner: TuiAgent | null
  lowerRungs: readonly (TuiAgent | null)[]
}): TuiAgent | null {
  const [trustedCommand, untrustedCommand] = resolveCommandAgentEvidence({
    agent: args.command,
    trusted: args.commandTrusted,
    titleAgent: args.title,
    owner: args.owner
  })
  return (
    args.liveFocused ??
    args.process ??
    trustedCommand ??
    args.title ??
    untrustedCommand ??
    args.lowerRungs.find((agent) => agent !== null) ??
    null
  )
}

import { planAgentBinary } from '../../agent-launch/startup/agent-command-plan'
import { structuredAgentCommandPlan } from '../../agent-launch/startup/tui-agent-launch-command-override'

export type ModelMenuInvocation = {
  nativeRuntime: boolean
  registered: boolean
  commandOverride?: string
  serverCommandOverride?: string
  paired: boolean
  platform?: NodeJS.Platform
}

/** A host listing is useful only for the exact invocation this menu launches. */
export function modelMenuUsesHostCatalog(input: ModelMenuInvocation): boolean {
  if (!input.nativeRuntime || !input.registered) {
    return false
  }
  const command = input.commandOverride?.trim() ?? ''
  if (input.paired && command !== (input.serverCommandOverride?.trim() ?? '')) {
    return false
  }
  if (!command) {
    return true
  }
  const structured = structuredAgentCommandPlan(command, input.platform)
  const terminal = planAgentBinary(
    '',
    command,
    input.platform === 'win32' || /^(?:["']?)(?:[A-Za-z]:[\\/]|\\\\)/.test(command)
      ? 'literal'
      : 'escape'
  )
  return (
    !!structured &&
    terminal.ok &&
    !terminal.env &&
    structured.program === terminal.binary &&
    structured.prefixArgs.length === terminal.prefixArgs.length &&
    structured.prefixArgs.every((arg, index) => arg === terminal.prefixArgs[index])
  )
}

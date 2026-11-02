import type { TuiAgent } from './tui-agent'
import { getAgentLaunchExecutableName } from './agent-command-line-intent'
import { findOptionOccurrence } from './command-option-occurrence'

export class OpenCodeCopyServerRouteError extends Error {
  constructor() {
    super(
      'Remove --server from the OpenCode command or arguments in Settings to open a copy in a CLI.'
    )
  }
}

/** A configured server may not hold the copy saved by this execution host. */
export function assertOpenCodeCopyUsesLocalStore(
  args: readonly string[],
  prefixArgs: readonly string[] = []
): void {
  // An opaque launcher prefix can contain its own terminators before the provider's flags.
  if (
    findOptionOccurrence(prefixArgs, ['--server'], false) ||
    findOptionOccurrence(args, ['--server'], true)
  ) {
    throw new OpenCodeCopyServerRouteError()
  }
}

function openCodeCommandAgent(launchCommand: string | undefined): 'opencode' | 'opencode2' | null {
  const binary = getAgentLaunchExecutableName(launchCommand)
  return binary === 'opencode' || binary === 'opencode2' ? binary : null
}

export function isOpenCode2LaunchCommand(launchCommand: string | undefined): boolean {
  return openCodeCommandAgent(launchCommand) === 'opencode2'
}

export function selectOpenCodeHookAgent(
  launchAgent: TuiAgent | undefined,
  launchCommand: string | undefined,
  isEnabled: (agent: 'opencode' | 'opencode2') => boolean
): 'opencode' | 'opencode2' | null {
  const explicit =
    launchAgent === 'opencode' || launchAgent === 'opencode2'
      ? launchAgent
      : launchAgent === undefined
        ? openCodeCommandAgent(launchCommand)
        : null
  // An explicit version selects its own integration; disabling it never substitutes the other.
  if (explicit) {
    return isEnabled(explicit) ? explicit : null
  }
  return isEnabled('opencode') ? 'opencode' : isEnabled('opencode2') ? 'opencode2' : null
}

import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'
import type { TuiAgent } from './tui-agent'

function openCodeCommandAgent(launchCommand: string | undefined): 'opencode' | 'opencode2' | null {
  const binary = getCommandTokenPathBasename(getFirstCommandToken(launchCommand ?? ''))
    .toLowerCase()
    .replace(/\.(?:cmd|exe|sh)$/, '')
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

// Names share one namespace with built-in agents and terminal commands.
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { formatAgentTypeLabel } from './agent-type-label'

const RESERVED_NAMES = new Set([
  'terminal',
  ...Object.keys(TUI_AGENT_CONFIG).flatMap((agent) => [
    agent,
    formatAgentTypeLabel(agent).toLowerCase()
  ])
])

export function validateAgentLaunchProfileName(
  name: string,
  profiles: readonly { id: string; name: string }[],
  editingId?: string
): string | null {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed.length > 60 ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return 'Enter a profile name of 1–60 characters without control characters.'
  }
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) {
    return 'Choose a name different from a built-in agent.'
  }
  if (
    profiles.some(
      (profile) =>
        profile.id !== editingId && profile.name.trim().toLowerCase() === trimmed.toLowerCase()
    )
  ) {
    return 'A profile with that name already exists.'
  }
  return null
}

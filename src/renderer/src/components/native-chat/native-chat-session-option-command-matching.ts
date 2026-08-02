import type { CatalogMidSessionApply } from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'

export function parseBuiltSessionOptionCommand(
  build: (value: SessionOptionValue) => string,
  command: string
): string | null {
  const marker = '__orca_session_option_value__'
  const template = build(marker)
  const markerIndex = template.indexOf(marker)
  if (markerIndex < 0) {
    return null
  }
  const prefix = template.slice(0, markerIndex)
  const suffix = template.slice(markerIndex + marker.length)
  if (!command.startsWith(prefix) || !command.endsWith(suffix)) {
    return null
  }
  const value = command.slice(prefix.length, command.length - suffix.length).trim()
  return value || null
}

export function isSessionOptionAgentPickerCommand(
  midSession: CatalogMidSessionApply | undefined,
  command: string
): boolean {
  return (
    (midSession?.kind === 'agent-picker' && command === midSession.command) ||
    (midSession?.kind === 'command' && command === midSession.pickerCommand)
  )
}

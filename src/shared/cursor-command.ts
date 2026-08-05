import type { DetectedAgentInventoryV1 } from './detected-agent-inventory'

export function resolveEffectiveCursorCommand(
  override: string | null | undefined,
  inventory: DetectedAgentInventoryV1 | null | undefined
): string | null {
  const configured = override?.trim()
  if (configured) {
    return configured
  }
  return cursorLaunchCommandFromMatch(inventory?.matchedCommands.cursor)
}

export function cursorLaunchCommandFromMatch(match: string | null | undefined): string | null {
  const normalized = match?.trim()
  if (normalized === 'cursor-agent') {
    return 'cursor-agent'
  }
  if (normalized === 'cursor agent') {
    return 'cursor agent'
  }
  return null
}

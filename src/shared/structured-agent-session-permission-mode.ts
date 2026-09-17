export const STRUCTURED_AGENT_SESSION_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto'
] as const

export type StructuredAgentSessionPermissionMode =
  (typeof STRUCTURED_AGENT_SESSION_PERMISSION_MODES)[number]

export function readStructuredAgentSessionPermissionMode(
  value: unknown
): StructuredAgentSessionPermissionMode | null {
  return STRUCTURED_AGENT_SESSION_PERMISSION_MODES.find((mode) => mode === value) ?? null
}

export function isStructuredAgentSessionPermissionModeRestoreValue(
  value: unknown
): value is Exclude<StructuredAgentSessionPermissionMode, 'plan'> {
  const mode = readStructuredAgentSessionPermissionMode(value)
  return mode !== null && mode !== 'plan'
}

export function structuredAgentSessionPermissionModeLabel(
  mode: StructuredAgentSessionPermissionMode
): string {
  switch (mode) {
    case 'default':
      return 'Normal'
    case 'acceptEdits':
      return 'Accept edits'
    case 'bypassPermissions':
      return 'Bypass permissions'
    case 'plan':
      return 'Plan'
    case 'dontAsk':
      return "Don't ask"
    case 'auto':
      return 'Auto'
  }
}

import type { KeybindingFileDiagnostic } from './types'

// One English table: producers build the English text, the renderer translates by code with these fallbacks.
/** Whole sentences that stand alone or fill a diagnostic's {{reason}}. */
export const KEYBINDING_REASON_COPY = {
  invalidFormat: 'Use a shortcut like Ctrl+Shift+P or Cmd+K.',
  mixedModifiers: 'Use either Mod or a platform-specific modifier, not both.',
  modifierRequired: 'Include at least one modifier key.',
  digitKeyRequired: 'Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.',
  modifierOnly: 'Press a key, not only a modifier.',
  invalidBindingValue: 'Use a string, string array, null, or false.',
  stringArrayRequired: 'Use a string array.',
  fileNotObject: 'Keybindings file must contain a JSON object.'
} as const

export type KeybindingReasonCode = keyof typeof KEYBINDING_REASON_COPY

export const KEYBINDING_DIAGNOSTIC_COPY = {
  sectionNotObject: '{{section}} must be an object.',
  unknownAction: 'Unknown keybinding action "{{actionId}}" was ignored.',
  shortcutIgnored: 'Shortcut for "{{actionId}}" was ignored: {{reason}}',
  platformsNotObject: 'platforms must be an object with darwin, linux, or win32 sections.',
  unknownPlatform: 'Unknown platform "{{platform}}" was ignored.',
  conflictingOverrides: 'Conflicting custom shortcuts were ignored: {{actions}}.',
  readFailed: 'Could not read keybindings file: {{reason}}'
} as const

export type KeybindingDiagnosticCode = keyof typeof KEYBINDING_DIAGNOSTIC_COPY

export function keybindingValidationFailure(errorCode: KeybindingReasonCode): {
  ok: false
  error: string
  errorCode: KeybindingReasonCode
} {
  return { ok: false, error: KEYBINDING_REASON_COPY[errorCode], errorCode }
}

/** `reasonCode` names params.reason when it is one of Orca's sentences rather than verbatim text. */
export function keybindingFileDiagnostic(
  base: Pick<KeybindingFileDiagnostic, 'severity' | 'section' | 'actionId' | 'actionIds'>,
  code: KeybindingDiagnosticCode,
  params: Record<string, string> = {},
  reasonCode?: KeybindingReasonCode
): KeybindingFileDiagnostic {
  const message = KEYBINDING_DIAGNOSTIC_COPY[code].replace(
    /\{\{(\w+)\}\}/g,
    (slot, name: string) => (Object.hasOwn(params, name) ? params[name] : slot)
  )
  return {
    ...base,
    message,
    code,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(reasonCode ? { reasonCode } : {})
  }
}

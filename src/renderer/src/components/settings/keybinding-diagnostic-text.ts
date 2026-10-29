import { translate } from '@/i18n/i18n'
import {
  KEYBINDING_DIAGNOSTIC_COPY as DIAGNOSTIC_EN,
  KEYBINDING_REASON_COPY as REASON_EN,
  type KeybindingDiagnosticCode,
  type KeybindingFileDiagnostic,
  type KeybindingReasonCode,
  getKeybindingDefinition,
  isKeybindingActionId
} from '../../../../shared/keybindings'
import { localizedKeybindingTitle } from './keybinding-title-copy'

const REASON_COPY: Record<KeybindingReasonCode, () => string> = {
  invalidFormat: () =>
    translate('settings.shortcuts.validation.invalidFormat', REASON_EN.invalidFormat),
  mixedModifiers: () =>
    translate('settings.shortcuts.validation.mixedModifiers', REASON_EN.mixedModifiers),
  modifierRequired: () =>
    translate('settings.shortcuts.validation.modifierRequired', REASON_EN.modifierRequired),
  digitKeyRequired: () =>
    translate('settings.shortcuts.validation.digitKeyRequired', REASON_EN.digitKeyRequired),
  modifierOnly: () =>
    translate('settings.shortcuts.validation.modifierOnly', REASON_EN.modifierOnly),
  invalidBindingValue: () =>
    translate('settings.shortcuts.validation.invalidBindingValue', REASON_EN.invalidBindingValue),
  stringArrayRequired: () =>
    translate('settings.shortcuts.validation.stringArrayRequired', REASON_EN.stringArrayRequired),
  fileNotObject: () =>
    translate('settings.shortcuts.validation.fileNotObject', REASON_EN.fileNotObject)
}

function isReasonCode(code: unknown): code is KeybindingReasonCode {
  return typeof code === 'string' && Object.hasOwn(REASON_COPY, code)
}

/** Translates a coded Orca sentence; anything else (verbatim or unknown) stays as given. */
function keybindingReasonText(code: unknown, english: string): string {
  return isReasonCode(code) ? REASON_COPY[code]() : english
}

export function keybindingValidationErrorText(failure: {
  error: string
  errorCode?: unknown
}): string {
  return keybindingReasonText(failure.errorCode, failure.error)
}

type Params = Record<string, string | number | undefined>

function text(params: Params, name: string): string | null {
  const value = params[name]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function localizedActionTitles(actionIds: unknown): string | null {
  if (!Array.isArray(actionIds) || actionIds.length === 0) {
    return null
  }
  const titles: string[] = []
  for (const actionId of actionIds) {
    if (typeof actionId !== 'string') {
      return null
    }
    const definition = isKeybindingActionId(actionId) ? getKeybindingDefinition(actionId) : null
    titles.push(definition ? localizedKeybindingTitle(definition) : actionId)
  }
  return titles.join(', ')
}

// null = a required param is missing; the caller shows the host's English message.
const DIAGNOSTIC_COPY: Record<
  KeybindingDiagnosticCode,
  (params: Params, reasonCode: unknown, actionIds: unknown) => string | null
> = {
  sectionNotObject: (params) => {
    const section = text(params, 'section')
    return section === null
      ? null
      : translate(
          'settings.shortcuts.diagnostics.sectionNotObject',
          DIAGNOSTIC_EN.sectionNotObject,
          {
            section
          }
        )
  },
  unknownAction: (params) => {
    const actionId = text(params, 'actionId')
    return actionId === null
      ? null
      : translate('settings.shortcuts.diagnostics.unknownAction', DIAGNOSTIC_EN.unknownAction, {
          actionId
        })
  },
  shortcutIgnored: (params, reasonCode) => {
    const actionId = text(params, 'actionId')
    const reason = text(params, 'reason')
    return actionId === null || reason === null
      ? null
      : translate('settings.shortcuts.diagnostics.shortcutIgnored', DIAGNOSTIC_EN.shortcutIgnored, {
          actionId,
          reason: keybindingReasonText(reasonCode, reason)
        })
  },
  platformsNotObject: () =>
    translate(
      'settings.shortcuts.diagnostics.platformsNotObject',
      DIAGNOSTIC_EN.platformsNotObject
    ),
  unknownPlatform: (params) => {
    const platform = text(params, 'platform')
    return platform === null
      ? null
      : translate('settings.shortcuts.diagnostics.unknownPlatform', DIAGNOSTIC_EN.unknownPlatform, {
          platform
        })
  },
  conflictingOverrides: (params, _reasonCode, actionIds) => {
    const actions = localizedActionTitles(actionIds) ?? text(params, 'actions')
    return actions === null
      ? null
      : translate(
          'settings.shortcuts.diagnostics.conflictingOverrides',
          DIAGNOSTIC_EN.conflictingOverrides,
          { actions }
        )
  },
  readFailed: (params, reasonCode) => {
    const reason = text(params, 'reason')
    return reason === null
      ? null
      : translate('settings.shortcuts.diagnostics.readFailed', DIAGNOSTIC_EN.readFailed, {
          reason: keybindingReasonText(reasonCode, reason)
        })
  }
}

function isDiagnosticCode(code: unknown): code is KeybindingDiagnosticCode {
  return typeof code === 'string' && Object.hasOwn(DIAGNOSTIC_COPY, code)
}

/** Unknown codes (newer main) and uncoded diagnostics (older main) show `message` as sent. */
export function keybindingDiagnosticText(diagnostic: KeybindingFileDiagnostic): string {
  const { code } = diagnostic
  if (!isDiagnosticCode(code)) {
    return diagnostic.message
  }
  return (
    DIAGNOSTIC_COPY[code](diagnostic.params ?? {}, diagnostic.reasonCode, diagnostic.actionIds) ??
    diagnostic.message
  )
}

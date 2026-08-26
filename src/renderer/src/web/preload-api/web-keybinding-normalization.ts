import {
  findKeybindingConflicts,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction
} from '../../../../shared/keybindings'
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingOverrides,
  KeybindingPlatform
} from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'

export type WebKeybindingDocument = {
  version: 1
  keybindings: KeybindingOverrides
  platforms: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
}

export const WEB_KEYBINDING_PLATFORMS: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeStoredWebOverrides(
  value: unknown,
  section: string,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section,
      message: translate('auto.web.web.preload.api.d2e43e426a', '{{value0}} must be an object.', {
        value0: section
      })
    })
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBindings] of Object.entries(value)) {
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push({
        severity: 'warning',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.36761d9604',
          'Unknown keybinding action "{{value0}}" was ignored.',
          { value0: actionId }
        )
      })
      continue
    }
    if (
      !Array.isArray(rawBindings) ||
      !rawBindings.every((binding) => typeof binding === 'string')
    ) {
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.10898045f3',
          'Shortcut for "{{value0}}" was ignored: Use a string array.',
          { value0: actionId }
        )
      })
      continue
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, rawBindings)
    if (!Array.isArray(normalized)) {
      const error = normalized.ok ? 'Unable to parse shortcut.' : normalized.error
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.76122208ca',
          'Shortcut for "{{value0}}" was ignored: {{value1}}',
          { value0: actionId, value1: error }
        )
      })
      continue
    }
    overrides[actionId] = normalized
  }
  return overrides
}

export function normalizeWebPlatformOverrides(
  value: unknown,
  diagnostics: KeybindingFileDiagnostic[]
): Partial<Record<KeybindingPlatform, KeybindingOverrides>> {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section: 'platforms',
      message: translate(
        'auto.web.web.preload.api.0a69fcd8bc',
        'platforms must be an object with darwin, linux, or win32 sections.'
      )
    })
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, overrides] of Object.entries(value)) {
    if (!WEB_KEYBINDING_PLATFORMS.includes(platform as KeybindingPlatform)) {
      diagnostics.push({
        severity: 'warning',
        section: `platforms.${platform}`,
        message: translate(
          'auto.web.web.preload.api.32f15bdb0f',
          'Unknown platform "{{value0}}" was ignored.',
          { value0: platform }
        )
      })
      continue
    }
    result[platform as KeybindingPlatform] = normalizeStoredWebOverrides(
      overrides,
      `platforms.${platform}`,
      diagnostics
    )
  }
  return result
}

export function removeConflictingWebOverrides(
  platform: KeybindingPlatform,
  overrides: KeybindingOverrides,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  let next = { ...overrides }
  for (let attempt = 0; attempt < 20; attempt++) {
    const conflicts = findKeybindingConflicts(platform, next)
    const conflictingOverrides = new Set<KeybindingActionId>()
    for (const conflict of conflicts) {
      for (const actionId of conflict.actionIds) {
        if (Object.hasOwn(next, actionId)) {
          conflictingOverrides.add(actionId)
        }
      }
    }
    if (conflictingOverrides.size === 0) {
      return next
    }
    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }
    diagnostics.push({
      severity: 'error',
      message: translate(
        'auto.web.web.preload.api.52bee9d8a0',
        'Conflicting custom shortcuts were ignored: {{value0}}.',
        {
          value0: Array.from(conflictingOverrides)
            .map((actionId) => actionId)
            .join(', ')
        }
      )
    })
  }
  return next
}

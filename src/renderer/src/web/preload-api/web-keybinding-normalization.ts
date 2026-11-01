import {
  findKeybindingConflicts,
  isKeybindingActionId,
  keybindingFileDiagnostic,
  KEYBINDING_REASON_COPY,
  normalizeKeybindingArrayForAction
} from '../../../../shared/keybindings'
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingOverrides,
  KeybindingPlatform
} from '../../../../shared/keybindings'

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
    diagnostics.push(
      keybindingFileDiagnostic({ severity: 'error', section }, 'sectionNotObject', { section })
    )
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBindings] of Object.entries(value)) {
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push(
        keybindingFileDiagnostic({ severity: 'warning', section, actionId }, 'unknownAction', {
          actionId
        })
      )
      continue
    }
    if (
      !Array.isArray(rawBindings) ||
      !rawBindings.every((binding) => typeof binding === 'string')
    ) {
      diagnostics.push(
        keybindingFileDiagnostic(
          { severity: 'error', section, actionId },
          'shortcutIgnored',
          { actionId, reason: KEYBINDING_REASON_COPY.stringArrayRequired },
          'stringArrayRequired'
        )
      )
      continue
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, rawBindings)
    if (!Array.isArray(normalized)) {
      diagnostics.push(
        keybindingFileDiagnostic(
          { severity: 'error', section, actionId },
          'shortcutIgnored',
          { actionId, reason: normalized.ok ? 'Unable to parse shortcut.' : normalized.error },
          normalized.ok ? undefined : normalized.errorCode
        )
      )
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
    diagnostics.push(
      keybindingFileDiagnostic({ severity: 'error', section: 'platforms' }, 'platformsNotObject')
    )
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, overrides] of Object.entries(value)) {
    if (!WEB_KEYBINDING_PLATFORMS.includes(platform as KeybindingPlatform)) {
      diagnostics.push(
        keybindingFileDiagnostic(
          { severity: 'warning', section: `platforms.${platform}` },
          'unknownPlatform',
          { platform }
        )
      )
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
    next = { ...next }
    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }
    diagnostics.push(
      keybindingFileDiagnostic(
        { severity: 'error', actionIds: Array.from(conflictingOverrides) },
        'conflictingOverrides',
        {
          actions: Array.from(conflictingOverrides).join(', ')
        }
      )
    )
  }
  return next
}

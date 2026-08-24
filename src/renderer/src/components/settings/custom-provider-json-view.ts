import type { CustomProviderDraft } from './custom-provider-draft'
import { translate } from '@/i18n/i18n'

/** The subset of the draft shown/edited as JSON — token is intentionally
 *  excluded so a secret never sits in a plain-text, copy-pasteable box. */
export type CustomProviderJsonShape = {
  displayName?: string
  icon?: string
  usageUrl?: string
  /** The env var *name*, not its value — safe to show/edit as plain JSON. */
  tokenEnvVar?: string
  mappingMode?: string
  percentPath?: string
  usedPaths?: string[]
  limitPath?: string
}

export function serializeDraftToJson(draft: CustomProviderDraft): string {
  const shape: CustomProviderJsonShape = {
    displayName: draft.displayName,
    icon: draft.icon,
    usageUrl: draft.usageUrl,
    ...(draft.tokenEnvVar.trim() ? { tokenEnvVar: draft.tokenEnvVar } : {}),
    mappingMode: draft.mappingMode,
    ...(draft.mappingMode === 'percent'
      ? { percentPath: draft.percentPath }
      : { usedPaths: draft.usedPaths, limitPath: draft.limitPath })
  }
  return JSON.stringify(shape, null, 2)
}

const STRING_FIELDS = [
  'displayName',
  'icon',
  'usageUrl',
  'tokenEnvVar',
  'percentPath',
  'limitPath'
] as const

export type CustomProviderJsonValidation =
  | { ok: true; value: CustomProviderJsonShape }
  | { ok: false; error: string }

// Why: a lighter check than validateCustomProviderDraft — this only asserts
// the JSON is *shaped* correctly (right types, valid enum), not that it's
// complete/ready to save. Required-ness is still enforced by Test/Save.
export function validateCustomProviderJsonShape(parsed: unknown): CustomProviderJsonValidation {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.customProviderJsonView.mustBeObject',
        'Must be a JSON object.'
      )
    }
  }
  const obj = parsed as Record<string, unknown>
  const value: CustomProviderJsonShape = {}
  for (const key of STRING_FIELDS) {
    if (key in obj) {
      if (typeof obj[key] !== 'string') {
        return {
          ok: false,
          error: translate(
            'auto.components.settings.customProviderJsonView.mustBeString',
            '"{{value0}}" must be a string.',
            { value0: key }
          )
        }
      }
      value[key] = obj[key] as string
    }
  }
  if ('mappingMode' in obj) {
    if (obj.mappingMode !== 'percent' && obj.mappingMode !== 'used-limit') {
      return {
        ok: false,
        error: translate(
          'auto.components.settings.customProviderJsonView.invalidMappingMode',
          '"mappingMode" must be "percent" or "used-limit".'
        )
      }
    }
    value.mappingMode = obj.mappingMode
  }
  if ('usedPaths' in obj) {
    if (!Array.isArray(obj.usedPaths) || obj.usedPaths.some((path) => typeof path !== 'string')) {
      return {
        ok: false,
        error: translate(
          'auto.components.settings.customProviderJsonView.invalidUsedPaths',
          '"usedPaths" must be an array of strings.'
        )
      }
    }
    value.usedPaths = obj.usedPaths as string[]
  }
  return { ok: true, value }
}

export function mergeJsonIntoDraft(
  prev: CustomProviderDraft,
  json: CustomProviderJsonShape
): CustomProviderDraft {
  return {
    ...prev,
    displayName: json.displayName ?? prev.displayName,
    icon: json.icon ?? prev.icon,
    usageUrl: json.usageUrl ?? prev.usageUrl,
    tokenEnvVar: json.tokenEnvVar ?? prev.tokenEnvVar,
    mappingMode: (json.mappingMode as CustomProviderDraft['mappingMode']) ?? prev.mappingMode,
    percentPath: json.percentPath ?? prev.percentPath,
    usedPaths: json.usedPaths ?? prev.usedPaths,
    limitPath: json.limitPath ?? prev.limitPath
  }
}

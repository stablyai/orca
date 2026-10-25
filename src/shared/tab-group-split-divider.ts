import { HEX_COLOR_RE } from './color-validation'

/** Current dark workspace split token. Keep this the default so existing layouts do not shift. */
export const DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK = '#71717a'
/** Current light workspace split token. */
export const DEFAULT_TAB_GROUP_SPLIT_DIVIDER_LIGHT = '#868690'

export function resolveTabGroupSplitDividerColor(
  value: string | undefined,
  fallback: string
): string {
  const trimmed = value?.trim()
  if (!trimmed || !HEX_COLOR_RE.test(trimmed)) {
    return fallback
  }
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

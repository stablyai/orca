import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK,
  DEFAULT_TAB_GROUP_SPLIT_DIVIDER_LIGHT,
  resolveTabGroupSplitDividerColor
} from '../../../shared/tab-group-split-divider'

type TabGroupSplitDividerSettings = Pick<
  GlobalSettings,
  'tabGroupSplitDividerColorDark' | 'tabGroupSplitDividerColorLight'
>

export function resolveTabGroupSplitDividerAppearance(
  settings: TabGroupSplitDividerSettings | null | undefined,
  isDark: boolean
): string {
  return resolveTabGroupSplitDividerColor(
    isDark ? settings?.tabGroupSplitDividerColorDark : settings?.tabGroupSplitDividerColorLight,
    isDark ? DEFAULT_TAB_GROUP_SPLIT_DIVIDER_DARK : DEFAULT_TAB_GROUP_SPLIT_DIVIDER_LIGHT
  )
}

export function applyTabGroupSplitDividerAppearance(
  root: { style: { setProperty: (name: string, value: string) => void } },
  settings: TabGroupSplitDividerSettings | null | undefined,
  isDark: boolean
): void {
  root.style.setProperty(
    '--tab-group-split-divider',
    resolveTabGroupSplitDividerAppearance(settings, isDark)
  )
}

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'

export function areAppearanceSettingValuesEqual(a: unknown, b: unknown): boolean {
  return structuralValuesEqual(a, b)
}

export function getAppearanceDraftChangedKeys(
  settings: GlobalSettings,
  draft: Partial<GlobalSettings>
): (keyof GlobalSettings)[] {
  return (Object.keys(draft) as (keyof GlobalSettings)[]).filter(
    (key) => !areAppearanceSettingValuesEqual(settings[key], draft[key])
  )
}

export function getAppearanceDraftChanges(
  settings: GlobalSettings,
  draft: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const changes: Partial<GlobalSettings> = {}
  for (const key of getAppearanceDraftChangedKeys(settings, draft)) {
    copyAppearanceDraftValue(changes, draft, key)
  }
  return changes
}

function copyAppearanceDraftValue<Key extends keyof GlobalSettings>(
  changes: Partial<GlobalSettings>,
  draft: Partial<GlobalSettings>,
  key: Key
): void {
  changes[key] = draft[key]
}

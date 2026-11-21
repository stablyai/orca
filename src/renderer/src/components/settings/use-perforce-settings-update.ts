import { useEffect, useRef } from 'react'
import {
  normalizePerforceSettings,
  type PerforceSettings
} from '../../../../shared/perforce/perforce-settings'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

/**
 * Saves one Perforce setting at a time. Each save builds on the previous one, not on the last
 * render, so a second control committed before the store catches up cannot restore an old value.
 */
export function usePerforceSettingsUpdate(
  stored: GlobalSettings['perforce'],
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
): (patch: Partial<PerforceSettings>) => void {
  const latest = useRef(normalizePerforceSettings(stored))
  useEffect(() => {
    latest.current = normalizePerforceSettings(stored)
  }, [stored])
  return (patch) => {
    latest.current = { ...latest.current, ...patch }
    void updateSettings({ perforce: latest.current })
  }
}

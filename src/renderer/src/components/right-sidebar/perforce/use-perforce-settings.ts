import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  normalizePerforceSettings,
  type PerforceSettings
} from '../../../../../shared/perforce/perforce-settings'

/** The user's Settings > Perforce values with defaults filled in. */
export function usePerforceSettings(): PerforceSettings {
  const raw = useAppStore((s) => s.settings?.perforce)
  return useMemo(() => normalizePerforceSettings(raw), [raw])
}

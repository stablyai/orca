import { useCallback, useEffect, useRef } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { applyDocumentAppearance } from '@/lib/app-appearance-document'

export function useOnboardingThemePreview(
  settings: GlobalSettings | null,
  theme: GlobalSettings['theme']
) {
  const persistedThemeRef = useRef<GlobalSettings['theme']>(settings?.theme ?? 'dark')
  persistedThemeRef.current = settings?.theme ?? 'dark'
  const persistedSettingsRef = useRef(settings)
  persistedSettingsRef.current = settings

  const applyTheme = useCallback(
    (nextTheme: GlobalSettings['theme']) =>
      applyDocumentAppearance(settings, window.matchMedia('(prefers-color-scheme: dark)').matches, {
        theme: nextTheme
      }),
    [settings]
  )

  useEffect(() => applyTheme(theme), [applyTheme, theme])

  return { applyTheme, persistedSettingsRef, persistedThemeRef }
}

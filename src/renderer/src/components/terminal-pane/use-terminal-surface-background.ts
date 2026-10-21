import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { composeActiveTerminalTheme } from './terminal-appearance'
import { useSystemPrefersDark } from './use-system-prefers-dark'

/** Relative lightness of a `#rrggbb` colour, or null for anything else. */
function hexLightness(color: string): number | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color)
  if (!match) {
    return null
  }
  const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The colour terminals paint behind their text, so a surface they replace can match it. Null when
 * the terminal's light/dark differs from the app's, since app text would then be unreadable on it,
 * unless `matchAppMode` is off for a surface whose text sits on its own card.
 */
export function useTerminalSurfaceBackground({ matchAppMode = true } = {}): string | null {
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  return useMemo(() => {
    if (!settings) {
      return null
    }
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    const theme = composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    )
    const background = theme?.background
    const lightness = background ? hexLightness(background) : null
    if (!background || lightness === null) {
      return null
    }
    return !matchAppMode || lightness < 0.5 === (appearance.mode === 'dark') ? background : null
  }, [matchAppMode, settings, systemPrefersDark])
}

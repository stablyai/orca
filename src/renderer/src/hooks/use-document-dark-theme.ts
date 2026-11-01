import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { resolvePaintedDark } from '@/lib/terminal-app-theme'

/** The mode the Appearance setting asks for; it picks the app and terminal theme slots. */
export function useSettingsDarkTheme(): boolean {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  return theme === 'system' ? systemPrefersDark : theme === 'dark'
}

/** The mode Orca is painted in: the requested one, unless Match Terminal follows a terminal
 *  theme of the other mode. */
export function useDocumentDarkTheme(): boolean {
  const requestedDark = useSettingsDarkTheme()
  const systemPrefersDark = useSystemPrefersDark()
  return useAppStore((s) => resolvePaintedDark(s.settings, requestedDark, systemPrefersDark))
}

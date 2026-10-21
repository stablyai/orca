import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

/** Resolved app theme that re-renders when a `system` theme flips with the OS. */
export function useDocumentDarkTheme(): boolean {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  return theme === 'system' ? systemPrefersDark : theme === 'dark'
}

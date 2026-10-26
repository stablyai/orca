import { useAppStore } from '@/store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'

export function useDocumentDarkTheme(): boolean {
  const theme = useAppStore((s) => s.settings?.theme ?? 'system')
  const systemPrefersDark = useSystemPrefersDark()
  return theme === 'system' ? systemPrefersDark : theme === 'dark'
}

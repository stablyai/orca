import { useShortcutKeyDetails } from '@/lib/keyboard/useShortcutLabel'

export function useFloatingTerminalShortcutDetails() {
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newBrowserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const newMarkdownShortcut = useShortcutKeyDetails('tab.newMarkdown')
  const openMarkdownShortcut = useShortcutKeyDetails('tab.openMarkdown')
  const closeShortcut = useShortcutKeyDetails('tab.close')

  return {
    newTerminalShortcut,
    newBrowserShortcut,
    newMarkdownShortcut,
    openMarkdownShortcut,
    closeShortcut
  }
}

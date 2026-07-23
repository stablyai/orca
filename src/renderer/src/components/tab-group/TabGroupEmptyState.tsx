import { memo } from 'react'
import { FileText, Globe, TerminalSquare } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

const ACTION_CLASS_NAME =
  'grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground'

type TabGroupEmptyStateProps = {
  onNewTerminal: () => void
  onNewMarkdown: () => void
  onNewBrowser: () => void
}

export const TabGroupEmptyState = memo(function TabGroupEmptyState({
  onNewTerminal,
  onNewMarkdown,
  onNewBrowser
}: TabGroupEmptyStateProps): React.JSX.Element {
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newBrowserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const newMarkdownShortcut = useShortcutKeyDetails('tab.newMarkdown')

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex w-[360px] flex-col items-center gap-1.5">
        <Button type="button" variant="ghost" className={ACTION_CLASS_NAME} onClick={onNewTerminal}>
          <TerminalSquare className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.tab.group.TabGroupPanel.emptyState.newTerminal',
              'New Terminal'
            )}
          </span>
          {newTerminalShortcut.keys.length > 0 ? (
            <ShortcutKeyCombo
              keys={newTerminalShortcut.keys}
              doubleTap={newTerminalShortcut.doubleTap}
            />
          ) : null}
        </Button>
        <Button type="button" variant="ghost" className={ACTION_CLASS_NAME} onClick={onNewMarkdown}>
          <FileText className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.tab.group.TabGroupPanel.emptyState.newMarkdown',
              'New Markdown Note'
            )}
          </span>
          {newMarkdownShortcut.keys.length > 0 ? (
            <ShortcutKeyCombo
              keys={newMarkdownShortcut.keys}
              doubleTap={newMarkdownShortcut.doubleTap}
            />
          ) : null}
        </Button>
        <Button type="button" variant="ghost" className={ACTION_CLASS_NAME} onClick={onNewBrowser}>
          <Globe className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.tab.group.TabGroupPanel.emptyState.newBrowser',
              'New Browser'
            )}
          </span>
          {newBrowserShortcut.keys.length > 0 ? (
            <ShortcutKeyCombo
              keys={newBrowserShortcut.keys}
              doubleTap={newBrowserShortcut.doubleTap}
            />
          ) : null}
        </Button>
      </div>
    </div>
  )
})

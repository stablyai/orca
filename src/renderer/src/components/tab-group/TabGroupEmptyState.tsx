import { memo } from 'react'
import { FileText, Globe, TerminalSquare } from 'lucide-react'
import { WorkspaceEmptyStateAction } from '@/components/WorkspaceEmptyStateAction'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

type TabGroupEmptyStateProps = {
  onNewTerminal: () => void
  onNewMarkdown: () => void
  onNewBrowser: () => void
  showNewBrowser: boolean
}

/** Omits browser creation when the workspace host policy disables it. */
export const TabGroupEmptyState = memo(function TabGroupEmptyState({
  onNewTerminal,
  onNewMarkdown,
  onNewBrowser,
  showNewBrowser
}: TabGroupEmptyStateProps): React.JSX.Element {
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newBrowserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const newMarkdownShortcut = useShortcutKeyDetails('tab.newMarkdown')

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex w-[360px] flex-col items-center gap-1.5">
        <WorkspaceEmptyStateAction
          icon={<TerminalSquare className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.tab.group.TabGroupEmptyState.3215fc73e9',
            'New Terminal'
          )}
          shortcut={newTerminalShortcut}
          onClick={onNewTerminal}
        />
        <WorkspaceEmptyStateAction
          icon={<FileText className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.tab.group.TabGroupEmptyState.629528690b',
            'New Markdown Note'
          )}
          shortcut={newMarkdownShortcut}
          onClick={onNewMarkdown}
        />
        {showNewBrowser ? (
          <WorkspaceEmptyStateAction
            icon={<Globe className="size-3.5 opacity-90" />}
            label={translate(
              'auto.components.tab.group.TabGroupEmptyState.8b07759314',
              'New Browser'
            )}
            shortcut={newBrowserShortcut}
            onClick={onNewBrowser}
          />
        ) : null}
      </div>
    </div>
  )
})

import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { WorkspaceEmptyStateAction } from '@/components/WorkspaceEmptyStateAction'

type FloatingTerminalEmptyStateProps = {
  onNewTerminal: () => void
  onNewMarkdown: () => void
  onOpenMarkdown: () => void
  onNewBrowser: () => void
  showNewBrowser: boolean
  onClose: () => void
  onFocusPanel: () => void
  newTerminalShortcut: ShortcutKeyComboDetails
  newBrowserShortcut: ShortcutKeyComboDetails
  newMarkdownShortcut: ShortcutKeyComboDetails
  openMarkdownShortcut: ShortcutKeyComboDetails
  closeShortcut: ShortcutKeyComboDetails
}

export function FloatingTerminalEmptyState({
  onNewTerminal,
  onNewMarkdown,
  onOpenMarkdown,
  onNewBrowser,
  showNewBrowser,
  onClose,
  onFocusPanel,
  newTerminalShortcut,
  newBrowserShortcut,
  newMarkdownShortcut,
  openMarkdownShortcut,
  closeShortcut
}: FloatingTerminalEmptyStateProps): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      data-floating-terminal-empty-state
      data-floating-terminal-shortcut-surface
      onPointerDown={onFocusPanel}
    >
      <div className="flex w-[360px] flex-col items-center gap-1.5" data-floating-terminal-no-drag>
        <WorkspaceEmptyStateAction
          icon={<TerminalSquare className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.floating.terminal.FloatingTerminalPanel.3215fc73e9',
            'New Terminal'
          )}
          shortcut={newTerminalShortcut}
          contextualTourTarget="floating-workspace-new-terminal"
          onClick={onNewTerminal}
        />
        <WorkspaceEmptyStateAction
          icon={<FileText className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.floating.terminal.FloatingTerminalPanel.629528690b',
            'New Markdown Note'
          )}
          shortcut={newMarkdownShortcut}
          contextualTourTarget="floating-workspace-new-markdown"
          onClick={onNewMarkdown}
        />
        <WorkspaceEmptyStateAction
          icon={<FileText className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.floating.terminal.FloatingTerminalPanel.88ffb502e5',
            'Open Markdown Note'
          )}
          shortcut={openMarkdownShortcut}
          onClick={onOpenMarkdown}
        />
        {showNewBrowser ? (
          <WorkspaceEmptyStateAction
            icon={<Globe className="size-3.5 opacity-90" />}
            label={translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.8b07759314',
              'New Browser'
            )}
            shortcut={newBrowserShortcut}
            onClick={onNewBrowser}
          />
        ) : null}
        <WorkspaceEmptyStateAction
          icon={<Minus className="size-3.5 opacity-90" />}
          label={translate(
            'auto.components.floating.terminal.FloatingTerminalPanel.fc1042e92b',
            'Minimize'
          )}
          shortcut={closeShortcut}
          onClick={onClose}
        />
      </div>
    </div>
  )
}

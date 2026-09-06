import { FileText, Globe, Minus, TerminalSquare } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

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
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          data-contextual-tour-target="floating-workspace-new-terminal"
          onClick={onNewTerminal}
        >
          <TerminalSquare className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.3215fc73e9',
              'New Terminal'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={newTerminalShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          data-contextual-tour-target="floating-workspace-new-markdown"
          onClick={onNewMarkdown}
        >
          <FileText className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.629528690b',
              'New Markdown Note'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={newMarkdownShortcut} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenMarkdown}
        >
          <FileText className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.88ffb502e5',
              'Open Markdown Note'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={openMarkdownShortcut} />
        </Button>
        {showNewBrowser ? (
          <Button
            type="button"
            variant="ghost"
            className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
            onClick={onNewBrowser}
          >
            <Globe className="size-3.5 opacity-90" />
            <span className="truncate text-left leading-none">
              {translate(
                'auto.components.floating.terminal.FloatingTerminalPanel.8b07759314',
                'New Browser'
              )}
            </span>
            <FloatingEmptyStateShortcut shortcut={newBrowserShortcut} />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={onClose}
        >
          <Minus className="size-3.5 opacity-90" />
          <span className="truncate text-left leading-none">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.fc1042e92b',
              'Minimize'
            )}
          </span>
          <FloatingEmptyStateShortcut shortcut={closeShortcut} />
        </Button>
      </div>
    </div>
  )
}

function FloatingEmptyStateShortcut({
  shortcut
}: {
  shortcut: ShortcutKeyComboDetails
}): React.JSX.Element {
  if (shortcut.keys.length === 0) {
    return <span aria-hidden />
  }
  return (
    <ShortcutKeyCombo
      keys={shortcut.keys}
      doubleTap={shortcut.doubleTap}
      className="self-center justify-self-end opacity-90 [&>span]:text-foreground"
      separatorClassName="mx-0 text-[9px] text-foreground"
    />
  )
}

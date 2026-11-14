import { ExternalLink, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { focusTerminalTab, dockTerminalTab } from '@/lib/workspace-popout/workspace-popout-state'

type TerminalPopoutOverlayProps = {
  worktreeId: string
  tabId: string
}

export function TerminalPopoutOverlay({
  worktreeId,
  tabId: _tabId
}: TerminalPopoutOverlayProps): React.JSX.Element {
  const t = useTranslate()

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-background/85 p-6 backdrop-blur-sm select-none"
      data-testid="terminal-popout-overlay"
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ExternalLink className="size-6" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">
          {t('components.terminal.pane.popout.title', 'Terminal open in companion window')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            'components.terminal.pane.popout.description',
            'This terminal is running in a dedicated window. Keystrokes and output are directed there.'
          )}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void focusTerminalTab(worktreeId)
            }}
          >
            <ExternalLink className="size-3.5" />
            {t('components.terminal.pane.popout.focus', 'Show Window')}
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              void dockTerminalTab(worktreeId)
            }}
          >
            <SquareTerminal className="size-3.5" />
            {t('components.terminal.pane.popout.dock', 'Reattach to Main Window')}
          </Button>
        </div>
      </div>
    </div>
  )
}

import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

/**
 * Shown in a tab group whose tabs are all closed. The workspace deliberately
 * stays selected at zero tabs (issue #11699) so the file tree, editor, and Git
 * keep working, which leaves this pane body with nothing else to render.
 */
export function TabGroupEmptyState({
  onNewTerminalTab
}: {
  onNewTerminalTab: () => void
}): React.JSX.Element {
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')

  return (
    <div
      data-testid="tab-group-empty-state"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <SquareTerminal className="size-7 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {translate('auto.components.tab.group.TabGroupEmptyState.title', 'No open tabs')}
        </p>
        <p className="max-w-xs text-[13px] leading-5 text-muted-foreground">
          {translate(
            'auto.components.tab.group.TabGroupEmptyState.description',
            'Files, search, and Git are still available for this workspace in the sidebar.'
          )}
        </p>
      </div>
      {/* Why: half the stack's gap binds the chip to the button it describes, so it doesn't read as a fourth item. */}
      <div className="flex flex-col items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onNewTerminalTab}>
          <SquareTerminal aria-hidden="true" />
          {translate('auto.components.tab.group.TabGroupEmptyState.newTerminal', 'New terminal')}
        </Button>
        {newTerminalShortcut.keys.length > 0 ? (
          <ShortcutKeyCombo
            keys={newTerminalShortcut.keys}
            doubleTap={newTerminalShortcut.doubleTap}
            separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
          />
        ) : null}
      </div>
    </div>
  )
}

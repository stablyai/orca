import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'

type TerminalQuickCommandDialogFooterProps = {
  canSave: boolean
  submitShortcutLabel: string
  onCancel: () => void
  onSave: () => void
}

export function TerminalQuickCommandDialogFooter({
  canSave,
  submitShortcutLabel,
  onCancel,
  onSave
}: TerminalQuickCommandDialogFooterProps): React.JSX.Element {
  return (
    <DialogFooter className="sm:items-center">
      <Button type="button" variant="outline" onClick={onCancel}>
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.28370f16b9',
          'Cancel'
        )}
      </Button>
      <Button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        title={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.8dff838dea',
          'Save ({{value0}})',
          { value0: submitShortcutLabel }
        )}
      >
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.2e2b958dfc',
          'Save'
        )}
        <ShortcutKeyCombo
          keys={[getScreenSubmitModifierLabel(), 'Enter']}
          className="ml-1"
          keyCapClassName="border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground/80 shadow-none"
        />
      </Button>
    </DialogFooter>
  )
}

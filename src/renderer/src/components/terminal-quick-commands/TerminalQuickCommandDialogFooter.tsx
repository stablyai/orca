import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
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
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel}>
        {translate("auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.28370f16b9", "Cancel")}</Button>
      <Button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        title={translate("auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.8dff838dea", "Save ({{value0}})", { value0: submitShortcutLabel })}
      >
        {translate("auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.2e2b958dfc", "Save")}<span className="ml-1 text-[10px] opacity-60">{submitShortcutLabel}</span>
      </Button>
    </DialogFooter>
  )
}

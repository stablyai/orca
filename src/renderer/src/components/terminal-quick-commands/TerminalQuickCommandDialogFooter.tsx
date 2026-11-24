import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'

type TerminalQuickCommandDialogFooterProps = {
  canSave: boolean
  saving: boolean
  submitShortcutLabel: string
  onCancel: () => void
  onSave: () => void
}

export function TerminalQuickCommandDialogFooter({
  canSave,
  saving,
  submitShortcutLabel,
  onCancel,
  onSave
}: TerminalQuickCommandDialogFooterProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogFooter className="border-t border-border px-6 py-4 sm:justify-end">
      <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
        {t(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.28370f16b9',
          'Cancel'
        )}
      </Button>
      <Button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        title={t(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.8dff838dea',
          'Save ({{value0}})',
          { value0: submitShortcutLabel }
        )}
      >
        {t(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialogFooter.2e2b958dfc',
          'Save'
        )}
        <span className="ml-1 text-[10px] opacity-60">{submitShortcutLabel}</span>
      </Button>
    </DialogFooter>
  )
}

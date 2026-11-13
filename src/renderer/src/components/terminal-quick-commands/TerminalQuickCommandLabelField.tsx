import type { Dispatch, SetStateAction } from 'react'
import type { TerminalQuickCommand } from '../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

type TerminalQuickCommandLabelFieldProps = {
  label: string
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
}

export function TerminalQuickCommandLabelField({
  label,
  setDraft
}: TerminalQuickCommandLabelFieldProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <Label>
        {t(
          'auto.components.terminal.quick.commands.TerminalQuickCommandLabelField.db17f1e41e',
          'Label'
        )}
      </Label>
      <Input
        value={label}
        onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
        placeholder={t(
          'auto.components.terminal.quick.commands.TerminalQuickCommandLabelField.66ea254301',
          'Start dev server'
        )}
      />
    </div>
  )
}

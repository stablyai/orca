import type { Dispatch, SetStateAction } from 'react'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type TerminalQuickCommandLabelFieldProps = {
  label: string
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
}

export function TerminalQuickCommandLabelField({
  label,
  setDraft
}: TerminalQuickCommandLabelFieldProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandLabelField.db17f1e41e',
          'Label'
        )}
      </Label>
      <Input
        value={label}
        onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
        placeholder={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandLabelField.66ea254301',
          'Start dev server'
        )}
      />
    </div>
  )
}

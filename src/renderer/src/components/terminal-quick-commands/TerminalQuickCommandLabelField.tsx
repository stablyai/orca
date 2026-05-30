import type { Dispatch, SetStateAction } from 'react'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
      <Label>Label</Label>
      <Input
        value={label}
        onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
        placeholder="Start dev server"
      />
    </div>
  )
}

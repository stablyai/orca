import { useState } from 'react'
import type React from 'react'
import { Input } from '../ui/input'

type TerminalCustomShellInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onBlur'
> & {
  value: string
  onEdit: (next: string) => void
  onCommit: () => void
}

/**
 * Custom shell field that shows what was typed while it has focus.
 *
 * Why: settings writes come back trimmed, which would drop a space typed mid-path. The draft lives
 * in this component so it is discarded whenever the field unmounts, even without a blur.
 */
export function TerminalCustomShellInput({
  value,
  onEdit,
  onCommit,
  ...inputProps
}: TerminalCustomShellInputProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      {...inputProps}
      value={draft ?? value}
      onChange={(event) => {
        const next = event.target.value.trimStart()
        setDraft(next)
        onEdit(next)
      }}
      onBlur={() => {
        setDraft(null)
        onCommit()
      }}
    />
  )
}

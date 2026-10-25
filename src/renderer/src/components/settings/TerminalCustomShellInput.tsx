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

/** Retain focused draft whitespace through trimmed persistence echoes; component ownership discards drafts on unmount without blur. */
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

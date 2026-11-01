import type React from 'react'
import { Input } from '../ui/input'
import { useDebouncedSettingsTextDraft } from './use-debounced-settings-text-draft'

type DebouncedSettingsTextInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onBlur'
> & {
  value: string
  commit: (next: string) => void
  onEdit?: () => void
}

/** Own debounced drafts in a component because Settings search conditionally calls account render functions that cannot own hooks. */
export function DebouncedSettingsTextInput({
  value,
  commit,
  onEdit,
  ...inputProps
}: DebouncedSettingsTextInputProps): React.JSX.Element {
  const draft = useDebouncedSettingsTextDraft({ value, commit })
  return (
    <Input
      {...inputProps}
      value={draft.value}
      onChange={(event) => {
        onEdit?.()
        draft.onChange(event.target.value)
      }}
      onBlur={draft.onBlur}
    />
  )
}

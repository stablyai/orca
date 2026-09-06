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

/**
 * Text input for a free-text setting, committed on a debounce instead of per keystroke.
 *
 * Why a component and not a hook at the call site: the account sections are render functions the
 * settings search calls conditionally, so hooks cannot live in them. Rendering this as JSX gives
 * the draft its own component to mount and unmount with.
 */
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

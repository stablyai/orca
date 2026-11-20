import { useEffect, useState } from 'react'
import { Input } from '../../../ui/input'

/** '' means "unset"; null means the text is not a number. */
export function parseNumberDraft(
  text: string,
  min: number,
  max: number
): number | undefined | null {
  if (text.trim() === '') {
    return undefined
  }
  const value = Number(text)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null
}

/** Keeps what the user types as text and applies it on blur or Enter, so "95" is never clamped on the way. */
export function CommitNumberInput({
  value,
  onCommit,
  min,
  max,
  allowEmpty,
  ...props
}: {
  value: number | undefined
  onCommit: (value: number | undefined) => void
  min: number
  max: number
  allowEmpty: boolean
} & Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'onBlur' | 'min' | 'max'
>): React.JSX.Element {
  const shown = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = (): void => {
    const parsed = parseNumberDraft(draft, min, max)
    if (parsed === null || (parsed === undefined && !allowEmpty)) {
      setDraft(shown)
      return
    }
    setDraft(parsed === undefined ? '' : String(parsed))
    if (parsed !== value) {
      onCommit(parsed)
    }
  }
  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

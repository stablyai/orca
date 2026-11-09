import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'

/** A value being typed, masked by default. Reveal only ever shows what is typed now: saved values never come back. */
export function SecretValueInput({
  id,
  value,
  onChange,
  placeholder,
  invalid = false,
  autoFocus = false,
  disabled = false,
  describedBy
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  autoFocus?: boolean
  disabled?: boolean
  describedBy?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={revealed ? 'text' : 'password'}
        variant="code"
        adornment="trailing"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        data-1p-ignore=""
        className="h-8"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        className="absolute top-1/2 right-1 -translate-y-1/2"
        onClick={() => setRevealed((shown) => !shown)}
        aria-label={
          revealed
            ? t('cloudSecrets.value.hide', 'Hide value')
            : t('cloudSecrets.value.show', 'Show value')
        }
        aria-pressed={revealed}
      >
        {revealed ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}

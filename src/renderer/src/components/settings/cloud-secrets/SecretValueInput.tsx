import { useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Textarea } from '../../ui/textarea'

/**
 * A value being typed, masked by default. Reveal only ever shows what is typed now: saved values never
 * come back. A pasted multi-line value (a PEM key, JSON) keeps its newlines: while masked it shows only
 * its line count, so neither the screen nor a screen reader gets the content.
 */
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
  // A multi-line paste swaps the field for its summary; focus follows instead of dropping to <body>.
  const [pastedMultiline, setPastedMultiline] = useState(false)
  const multiline = value.includes('\n')
  const lines = multiline ? value.split('\n').length : 1
  const toggle = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      onClick={() => setRevealed((shown) => !shown)}
      aria-label={
        revealed
          ? t('cloudSecrets.value.hide', 'Hide value')
          : t('cloudSecrets.value.show', 'Show value')
      }
      aria-pressed={revealed}
      aria-controls={id}
    >
      {revealed ? <EyeOff /> : <Eye />}
    </Button>
  )

  if (multiline) {
    return (
      <div className="flex items-start gap-1">
        {revealed ? (
          <Textarea
            id={id}
            variant="code"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            data-1p-ignore=""
            autoFocus
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
                setRevealed(false)
              }
            }}
            className="max-h-48 min-h-20"
          />
        ) : (
          <Input
            id={id}
            readOnly
            autoFocus={pastedMultiline}
            variant="code"
            value={t('cloudSecrets.value.lines', 'Multi-line value · {{count}} lines', {
              count: lines,
              defaultValue_one: 'Multi-line value · {{count}} line'
            })}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            className="h-8"
          />
        )}
        {toggle}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          onClick={() => {
            onChange('')
            setRevealed(false)
          }}
          aria-label={t('cloudSecrets.value.clear', 'Clear value')}
        >
          <X />
        </Button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Input
        id={id}
        type={revealed ? 'text' : 'password'}
        variant="code"
        adornment="trailing"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          // An <input> drops newlines; keep a pasted PEM or JSON value whole instead.
          const pasted = event.clipboardData.getData('text')
          if (pasted.includes('\n')) {
            event.preventDefault()
            setPastedMultiline(true)
            onChange(pasted.replace(/\r\n?/g, '\n').replace(/\n+$/, ''))
          }
        }}
        // A revealed value goes back under the mask once focus leaves the field.
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) {
            setRevealed(false)
          }
        }}
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
      <div className="absolute top-1/2 right-1 -translate-y-1/2">{toggle}</div>
    </div>
  )
}

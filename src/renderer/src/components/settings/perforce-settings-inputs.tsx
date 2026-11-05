import { useState } from 'react'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { translate } from '@/i18n/i18n'

export const P4_PATH_PLACEHOLDER = '/usr/local/bin/p4'

type P4EnvironmentKey = 'p4Port' | 'p4User' | 'p4Client' | 'p4Config'

const P4_ENVIRONMENT_FIELDS = [
  ['p4Port', 'P4PORT', 'ssl:perforce.example.com:1666'],
  ['p4User', 'P4USER', 'username'],
  ['p4Client', 'P4CLIENT', 'workspace name'],
  ['p4Config', 'P4CONFIG', '.p4config']
] as const

/** P4PORT, P4USER, P4CLIENT and P4CONFIG overrides; an empty one falls back to the p4 environment. */
export function P4EnvironmentInputs({
  values,
  onCommit
}: {
  values: Record<P4EnvironmentKey, string>
  onCommit: (key: P4EnvironmentKey, value: string) => void
}): React.JSX.Element {
  return (
    <div className="grid w-72 gap-2">
      {P4_ENVIRONMENT_FIELDS.map(([key, label, placeholder]) => (
        <CommitInput
          key={key}
          value={values[key]}
          ariaLabel={label}
          placeholder={`${label} — ${placeholder}`}
          onCommit={(next) => onCommit(key, next)}
        />
      ))}
    </div>
  )
}

/** Text input that commits on blur/Enter so each keystroke is not a settings write. */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  className
}: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  ariaLabel: string
  className?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  const commit = (): void => {
    if (draft !== value) {
      onCommit(draft)
    }
  }
  return (
    <Input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && commit()}
    />
  )
}

export function TemplateField({
  value,
  onCommit,
  ariaLabel,
  placeholder
}: {
  value: string
  onCommit: (value: string) => void
  ariaLabel?: string
  placeholder?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Textarea
      value={draft}
      rows={3}
      aria-label={ariaLabel ?? translate('perforce.settings.new.template', 'Description template')}
      placeholder={
        placeholder ??
        translate(
          'perforce.settings.new.templatePlaceholder',
          'Description template, e.g. [{user}] '
        )
      }
      className="min-h-0"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  )
}

export function InstructionsField({
  value,
  onCommit
}: {
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Textarea
      value={draft}
      rows={4}
      aria-label={translate('perforce.settings.ai.instructions', 'Instructions')}
      placeholder={translate(
        'perforce.settings.ai.instructionsPlaceholder',
        'Extra instructions for the description, e.g. "Start with the ticket id."'
      )}
      className="min-h-0"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
    />
  )
}

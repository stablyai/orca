import { useState } from 'react'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { translate } from '@/i18n/i18n'

export /** Text input that commits on blur/Enter so each keystroke is not a settings write. */
function CommitInput({
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
      rows={3}
      aria-label={translate('perforce.settings.new.template', 'Description template')}
      placeholder={translate(
        'perforce.settings.new.templatePlaceholder',
        'Description template, e.g. [{user}] '
      )}
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

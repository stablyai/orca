import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  agentSessionFormChoices,
  agentSessionFormDraftContent,
  initialAgentSessionFormDraft,
  type AgentSessionForm,
  type AgentSessionFormContent
} from '../../../../shared/agent-session-form'

export function NativeChatForm({
  form,
  disabled,
  submitDisabled = false,
  onSubmit
}: {
  form: AgentSessionForm
  submitDisabled?: boolean
  disabled: boolean
  onSubmit: (content: AgentSessionFormContent) => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(() => initialAgentSessionFormDraft(form))
  const [error, setError] = useState<string | null>(null)
  const edit = (name: string, value: string | boolean | undefined): void => {
    setDraft((current) => {
      const next = new Map(current)
      if (value === undefined) {
        next.delete(name)
      } else {
        next.set(name, value)
      }
      return next
    })
    setError(null)
  }
  return (
    <form
      className="min-h-0 space-y-3 overflow-auto scrollbar-sleek"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || submitDisabled) {
          return
        }
        try {
          onSubmit(agentSessionFormDraftContent(form, draft))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Check the form values.')
        }
      }}
    >
      {form.fields.map((field, fieldIndex) => {
        const fieldId = `${id}-${fieldIndex}`
        const value = draft.get(field.name)
        const choices = agentSessionFormChoices(field)
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={fieldId}>{field.schema.title ?? field.name}</Label>
              {!field.required ? (
                <>
                  <span className="text-xs text-muted-foreground">Optional</span>
                  {value !== undefined ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`Clear ${field.schema.title ?? field.name}`}
                      onClick={() => edit(field.name, undefined)}
                    >
                      Clear
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
            {field.schema.description ? (
              <p className="text-sm text-muted-foreground">{field.schema.description}</p>
            ) : null}
            {choices.length > 0 ? (
              <RadioGroup
                id={fieldId}
                aria-label={field.schema.title ?? field.name}
                disabled={disabled}
                value={String(choices.findIndex((choice) => choice.value === value))}
                onValueChange={(index) => {
                  const choice = choices[Number(index)]
                  if (choice) {
                    edit(field.name, choice.value)
                  }
                }}
              >
                {choices.map((choice, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <RadioGroupItem id={`${fieldId}-${index}`} value={String(index)} />
                    <Label htmlFor={`${fieldId}-${index}`}>{choice.label}</Label>
                  </div>
                ))}
              </RadioGroup>
            ) : (
              <Input
                id={fieldId}
                value={typeof value === 'string' ? value : ''}
                disabled={disabled}
                aria-invalid={error !== null}
                onChange={(event) => edit(field.name, event.target.value)}
              />
            )}
          </div>
        )
      })}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={disabled || submitDisabled}>
        Submit
      </Button>
    </form>
  )
}

import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  agentSessionFormBooleanLabels,
  agentSessionFormErrorMessage
} from '../../../../shared/agent-session-form-copy'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  agentSessionFormChoices,
  checkAgentSessionFormDraft,
  initialAgentSessionFormDraft,
  type AgentSessionForm,
  type AgentSessionFormContent
} from '../../../../shared/agent-session-form'

/** The card's Submit button sits in its action row and joins this form by `form={id}`. */
export function NativeChatForm({
  id: formId,
  form,
  disabled,
  submitDisabled = false,
  onSubmit
}: {
  id: string
  form: AgentSessionForm
  submitDisabled?: boolean
  disabled: boolean
  onSubmit: (content: AgentSessionFormContent) => void
}): React.JSX.Element {
  useUiLanguageRevision()
  const t = translate
  const id = useId()
  const [draft, setDraft] = useState(() => initialAgentSessionFormDraft(form))
  const [errors, setErrors] = useState<{
    fields: ReadonlyMap<string, unknown>
    form: unknown
  }>({ fields: new Map(), form: null })
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
    setErrors((current) => {
      const fields = new Map(current.fields)
      fields.delete(name)
      return { fields, form: null }
    })
  }
  return (
    <form
      id={formId}
      className="min-h-0 space-y-3 overflow-auto scrollbar-sleek"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || submitDisabled) {
          return
        }
        const checked = checkAgentSessionFormDraft(form, draft)
        if (!('content' in checked)) {
          setErrors({ fields: checked.fieldErrors, form: checked.formError })
          return
        }
        setErrors({ fields: new Map(), form: null })
        try {
          onSubmit(checked.content)
        } catch (cause) {
          setErrors({ fields: new Map(), form: cause })
        }
      }}
    >
      {form.fields.map((field, fieldIndex) => {
        const fieldId = `${id}-${fieldIndex}`
        const errorId = `${fieldId}-error`
        const value = draft.get(field.name)
        const error = errors.fields.get(field.name)
        const invalid = errors.fields.has(field.name)
        const choices = agentSessionFormChoices(field, agentSessionFormBooleanLabels(t))
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={fieldId}>{field.schema.title ?? field.name}</Label>
              {!field.required ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t('components.native-chat.form.optional', 'Optional')}
                  </span>
                  {value !== undefined ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={t('components.native-chat.form.clearField', 'Clear {{field}}', {
                        field: field.schema.title ?? field.name
                      })}
                      onClick={() => edit(field.name, undefined)}
                    >
                      {t('components.native-chat.form.clear', 'Clear')}
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
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
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
                  <div key={String(choice.value)} className="flex items-center gap-2">
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
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(event) => edit(field.name, event.target.value)}
              />
            )}
            {invalid ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {agentSessionFormErrorMessage(error, t)}
              </p>
            ) : null}
          </div>
        )
      })}
      {errors.form !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {agentSessionFormErrorMessage(errors.form, t)}
        </p>
      ) : null}
    </form>
  )
}

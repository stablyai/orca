export type AgentSessionFormTranslate = (
  key: string,
  fallback: string,
  values?: Record<string, string | number>
) => string

type FormErrorCode =
  | 'choice'
  | 'text'
  | 'minLength'
  | 'maxLength'
  | 'format'
  | 'number'
  | 'integer'
  | 'minimum'
  | 'maximum'
  | 'unknownField'
  | 'required'
  | 'draftNumber'

export class AgentSessionFormValidationError extends Error {
  constructor(
    readonly code: FormErrorCode,
    readonly values: Record<string, string | number> = {}
  ) {
    super()
    this.message = agentSessionFormErrorMessage(this, (_key, fallback, values) =>
      fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(values?.[name] ?? ''))
    )
  }
}

export function agentSessionFormBooleanLabels(t: AgentSessionFormTranslate) {
  return {
    yes: t('components.native-chat.form.yes', 'Yes'),
    no: t('components.native-chat.form.no', 'No')
  }
}

export function agentSessionFormErrorMessage(error: unknown, t: AgentSessionFormTranslate): string {
  if (error instanceof AgentSessionFormValidationError) {
    const values = error.values
    switch (error.code) {
      case 'choice':
        return t('components.native-chat.form.error.choice', 'Choose an offered value.')
      case 'text':
        return t('components.native-chat.form.error.text', 'Enter text.')
      case 'minLength':
        return t(
          'components.native-chat.form.error.minLength',
          'Enter at least {{minimum}} characters.',
          values
        )
      case 'maxLength':
        return t(
          'components.native-chat.form.error.maxLength',
          'Enter at most {{maximum}} characters.',
          values
        )
      case 'format':
        return t(
          'components.native-chat.form.error.format',
          'Enter a valid {{format}} value.',
          values
        )
      case 'number':
        return t('components.native-chat.form.error.number', 'Enter a finite number.')
      case 'integer':
        return t(
          'components.native-chat.form.error.integer',
          'Enter a whole number within the supported range.'
        )
      case 'minimum':
        return t(
          'components.native-chat.form.error.minimum',
          'Enter a value of at least {{minimum}}.',
          values
        )
      case 'maximum':
        return t(
          'components.native-chat.form.error.maximum',
          'Enter a value of at most {{maximum}}.',
          values
        )
      case 'unknownField':
        return t(
          'components.native-chat.form.error.unknownField',
          'The response includes an unknown field.'
        )
      case 'required':
        return t('components.native-chat.form.error.required', '{{field}}: Enter a value.', values)
      case 'draftNumber':
        return t(
          'components.native-chat.form.error.draftNumber',
          '{{field}}: Enter a number.',
          values
        )
    }
  }
  return t('components.native-chat.form.error.check', 'Check the form values.')
}

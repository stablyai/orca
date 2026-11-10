import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useTranslate } from '@/i18n/use-translate'
import { MAX_ENV_VAR_NAMES, parseEnvVarNames } from './environment-draft'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { FieldLabel } from './EnvironmentFormFields'
import { FOCUS_RING } from '../orca-cloud/cloud-focus'

export function EnvVarChipEditor({
  names,
  onChange,
  readOnly = false
}: {
  names: readonly string[]
  onChange?: (names: string[]) => void
  readOnly?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const labelId = useId()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState<string[]>([])

  const commit = (raw: string): void => {
    const { valid, invalid: bad } = parseEnvVarNames(raw)
    const next = [...names]
    for (const name of valid) {
      if (!next.includes(name) && next.length < MAX_ENV_VAR_NAMES) {
        next.push(name)
      }
    }
    setInvalid(bad)
    if (next.length !== names.length) {
      onChange?.(next)
    }
    setValue('')
  }

  return (
    <div className="space-y-2" role="group" aria-labelledby={labelId}>
      <FieldLabel
        id={labelId}
        htmlFor={readOnly ? undefined : inputId}
        hint={t(
          'cloudEnvironment.form.variablesHint',
          'Names only. Values come from Cloud secrets (Shared scope) with the same names and reach the install script at build time. They’re never stored in the environment.'
        )}
      >
        {t('cloudEnvironment.form.variables', 'Variables')}
      </FieldLabel>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          !readOnly &&
            cn(
              'min-h-9 rounded-md border border-input px-2 py-1.5',
              'focus-within:border-focus-ring focus-within:ring-1 focus-within:ring-focus-ring'
            )
        )}
        onClick={() => document.getElementById(inputId)?.focus()}
      >
        {names.map((name) => (
          <span
            key={name}
            className="inline-flex h-6 items-center gap-1 rounded bg-secondary pr-1 pl-2 font-mono text-xs text-secondary-foreground"
          >
            {name}
            {readOnly ? (
              <span className="w-1" />
            ) : (
              <button
                type="button"
                className={cn(
                  'rounded-sm p-0.5 text-muted-foreground hover:text-foreground',
                  FOCUS_RING
                )}
                aria-label={t('cloudEnvironment.form.removeEnvVar', 'Remove {{name}}', { name })}
                onClick={(event) => {
                  event.stopPropagation()
                  onChange?.(names.filter((entry) => entry !== name))
                }}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {readOnly ? (
          names.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {t('cloudEnvironment.form.noEnvVars', 'None')}
            </span>
          ) : null
        ) : (
          <input
            id={inputId}
            value={value}
            placeholder={
              names.length === 0
                ? t('cloudEnvironment.form.envVarPlaceholder', 'NPM_TOKEN, DATABASE_URL…')
                : undefined
            }
            className="h-6 min-w-32 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/50"
            aria-invalid={invalid.length > 0 ? true : undefined}
            aria-describedby={invalid.length > 0 ? `${inputId}-error` : undefined}
            onChange={(event) => {
              const next = event.target.value
              if (/[\s,;]$/.test(next)) {
                commit(next)
              } else {
                setValue(next.toUpperCase())
                setInvalid([])
              }
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text')
              if (/[\s,;=]/.test(text)) {
                event.preventDefault()
                commit(text)
              }
            }}
            onBlur={() => {
              if (value.trim()) {
                commit(value)
              }
            }}
            onKeyDown={(event) => {
              if (isImeOwnedKeyboardEvent(event)) {
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                commit(value)
              } else if (event.key === 'Backspace' && value === '' && names.length > 0) {
                onChange?.(names.slice(0, -1))
              }
            }}
          />
        )}
      </div>
      {invalid.length > 0 ? (
        <p id={`${inputId}-error`} className="text-xs text-destructive">
          {t(
            'cloudEnvironment.form.envVarInvalid',
            'Skipped {{names}}: names use A–Z, 0–9 and _, and cannot start with a digit.',
            { names: invalid.join(', ') }
          )}
        </p>
      ) : null}
    </div>
  )
}

/** There is one sandbox size, so this is a fact about the environment, not a setting. */
export function SandboxSizeInfo(): React.JSX.Element {
  const t = useTranslate()
  return (
    <dl className="space-y-1">
      <dt className="text-sm font-medium">{t('cloudEnvironment.size.label', 'Sandbox size')}</dt>
      <dd className="text-sm text-muted-foreground tabular-nums">
        {t('cloudEnvironment.size.spec', '{{value0}} vCPU · {{value1}} GB', {
          value0: String(ORCA_CLOUD_SANDBOX_SPEC.vcpus),
          value1: String(ORCA_CLOUD_SANDBOX_SPEC.memoryGb)
        })}
      </dd>
    </dl>
  )
}

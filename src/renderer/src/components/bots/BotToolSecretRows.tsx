import { useTranslate } from '@/i18n/use-translate'
import {
  BOT_TOOL_ENV_NAME_PATTERN,
  BOT_TOOL_HEADER_NAME_PATTERN
} from '../../../../shared/bot-tools'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/class-names'
import type { SecretDraft } from '../../../../shared/bots/bot-tool-draft'

// A saved value in a dense row: hidden, but plainly there.
const SAVED_DOTS = '\u2022'.repeat(16)

export function BotToolSecretRows({
  rows,
  kind,
  onChange,
  locked = false,
  dense = false
}: {
  rows: SecretDraft[]
  kind: 'header' | 'variable'
  onChange: (rows: SecretDraft[]) => void
  /** Settings' form: a lock on each value, and no note on how saved values work under the rows. */
  locked?: boolean
  /** 28 px fields, as a settings card's launch fields. */
  dense?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const update = (index: number, changes: Partial<SecretDraft>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)))
  const valueInput = (row: SecretDraft, index: number): React.JSX.Element => (
    <Input
      variant="code"
      adornment={locked ? 'trailing' : 'none'}
      className={cn('min-w-0 flex-1', dense && 'h-7')}
      type="password"
      autoComplete="new-password"
      aria-label={
        kind === 'header'
          ? t('settings.bots.tools.details.headerValue', 'header value {{index}}', {
              index: index + 1
            })
          : t('settings.bots.tools.details.variableValue', 'variable value {{index}}', {
              index: index + 1
            })
      }
      value={row.value}
      maxLength={4096}
      aria-invalid={row.key !== '' && !row.configured && row.value === ''}
      onChange={(event) => update(index, { value: event.target.value })}
      placeholder={
        row.configured && dense
          ? SAVED_DOTS
          : row.configured
            ? t('settings.bots.tools.details.savedPlaceholder', 'Saved value · enter to replace')
            : t('settings.bots.tools.details.valuePlaceholder', 'Value')
      }
    />
  )
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={row.id}
          className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr_auto]"
        >
          <Input
            variant="code"
            className={cn('min-w-0 flex-1', dense && 'h-7')}
            aria-label={
              kind === 'header'
                ? t('settings.bots.tools.details.headerName', 'header name {{index}}', {
                    index: index + 1
                  })
                : t('settings.bots.tools.details.variableName', 'variable name {{index}}', {
                    index: index + 1
                  })
            }
            value={row.key}
            maxLength={256}
            aria-invalid={
              row.key !== '' &&
              !(kind === 'header' ? BOT_TOOL_HEADER_NAME_PATTERN : BOT_TOOL_ENV_NAME_PATTERN).test(
                row.key
              )
            }
            onChange={(event) => update(index, { key: event.target.value, configured: false })}
            placeholder={t('settings.bots.tools.details.keyPlaceholder', 'Name')}
          />
          {locked ? (
            <span className="relative min-w-0 flex-1">
              {valueInput(row, index)}
              {/* Every value is a secret: stored by Orca, never written into an agent's file. */}
              <Lock
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
            </span>
          ) : (
            valueInput(row, index)
          )}
          <Button
            type="button"
            variant="ghost"
            className="justify-self-end"
            size={dense ? 'xs' : 'sm'}
            aria-label={
              kind === 'header'
                ? t('settings.bots.tools.details.removeHeader', 'Remove header {{index}}', {
                    index: index + 1
                  })
                : t('settings.bots.tools.details.removeVariable', 'Remove variable {{index}}', {
                    index: index + 1
                  })
            }
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            {t('settings.bots.tools.details.remove', 'Remove')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="link"
        size="inlineText"
        onClick={() =>
          onChange([...rows, { id: createBrowserUuid(), key: '', value: '', configured: false }])
        }
      >
        {kind === 'header'
          ? t('settings.bots.tools.details.addHeader', '+ Add header')
          : t('settings.bots.tools.details.addVariable', '+ Add variable')}
      </Button>
      <p hidden={locked} className="text-xs text-muted-foreground">
        {t(
          'settings.bots.tools.details.secretsHint',
          'Saved values stay private. Leave a saved value blank to keep it, enter a value to replace it, or remove its row to delete it.'
        )}
      </p>
    </div>
  )
}

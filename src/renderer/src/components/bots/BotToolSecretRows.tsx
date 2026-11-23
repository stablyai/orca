import { useTranslate } from '@/i18n/use-translate'
import {
  BOT_TOOL_ENV_NAME_PATTERN,
  BOT_TOOL_HEADER_NAME_PATTERN
} from '../../../../shared/bot-tools'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SecretDraft } from '../../../../shared/bots/bot-tool-draft'

export function BotToolSecretRows({
  rows,
  kind,
  onChange
}: {
  rows: SecretDraft[]
  kind: 'header' | 'variable'
  onChange: (rows: SecretDraft[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const update = (index: number, changes: Partial<SecretDraft>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)))
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={row.id}
          className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr_auto]"
        >
          <Input
            variant="code"
            className="min-w-0 flex-1"
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
          <Input
            variant="code"
            className="min-w-0 flex-1"
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
              row.configured
                ? t(
                    'settings.bots.tools.details.savedPlaceholder',
                    'Saved value · enter to replace'
                  )
                : t('settings.bots.tools.details.valuePlaceholder', 'Value')
            }
          />
          <Button
            type="button"
            variant="ghost"
            className="justify-self-end"
            size="sm"
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
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.bots.tools.details.secretsHint',
          'Saved values stay private. Leave a saved value blank to keep it, enter a value to replace it, or remove its row to delete it.'
        )}
      </p>
    </div>
  )
}

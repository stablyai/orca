import { useTranslate } from '@/i18n/use-translate'
import { BOT_TOOL_NAME_PATTERN, BotToolUrl } from '../../../../shared/bot-tools'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { BotToolSecretRows } from './BotToolSecretRows'
import type { BotToolDraft } from '../../../../shared/bots/bot-tool-draft'

export function BotToolDetailsFields({
  draft,
  onChange,
  focusName = false
}: {
  draft: BotToolDraft
  onChange: (draft: BotToolDraft) => void
  focusName?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const patch = (changes: Partial<BotToolDraft>) => onChange({ ...draft, ...changes })
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="bot-tool-mode">
          {t('settings.bots.tools.details.serverType', 'Server type')}
        </Label>
        <Select
          value={draft.mode}
          onValueChange={(mode) => {
            if (mode === 'url' || mode === 'command') {
              patch({ mode })
            }
          }}
        >
          <SelectTrigger id="bot-tool-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="url">
              {t('settings.bots.tools.details.urlMode', 'Connect to a URL')}
            </SelectItem>
            <SelectItem value="command">
              {t('settings.bots.tools.details.commandMode', 'Run a command')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bot-tool-name">
          {t('settings.bots.tools.details.serverName', 'Server name')}
        </Label>
        <Input
          id="bot-tool-name"
          autoFocus={focusName}
          maxLength={64}
          aria-invalid={draft.name !== '' && !BOT_TOOL_NAME_PATTERN.test(draft.name)}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          autoComplete="off"
        />
      </div>
      {draft.mode === 'url' ? (
        <>
          <div className="space-y-1">
            <Label htmlFor="bot-tool-url">
              {t('settings.bots.tools.details.url', 'Server URL')}
            </Label>
            <Input
              id="bot-tool-url"
              variant="code"
              value={draft.url}
              aria-invalid={draft.url !== '' && !BotToolUrl.safeParse(draft.url).success}
              onChange={(event) => patch({ url: event.target.value })}
              placeholder={t(
                'settings.bots.tools.details.urlPlaceholder',
                'https://example.com/mcp'
              )}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'settings.bots.tools.details.transport',
              'Streamable HTTP · localhost means this bot’s computer.'
            )}
          </p>
          <div className="space-y-2">
            <Label>{t('settings.bots.tools.details.headers', 'Headers')}</Label>
            <BotToolSecretRows
              kind="header"
              rows={draft.headers}
              onChange={(headers) => patch({ headers })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'settings.bots.tools.details.authHint',
              'If the server needs browser sign-in, Connect appears after its native check.'
            )}
          </p>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="bot-tool-command">
              {t('settings.bots.tools.details.executable', 'Executable')}
            </Label>
            <Input
              id="bot-tool-command"
              variant="code"
              value={draft.command}
              aria-invalid={
                draft.command !== draft.command.trim() || /[\r\n\0]/.test(draft.command)
              }
              onChange={(event) => patch({ command: event.target.value })}
              placeholder={t('settings.bots.tools.details.commandPlaceholder', 'npx')}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.bots.tools.details.args', 'Arguments')}</Label>
            {draft.args.map((arg, index) => (
              <div key={arg.id} className="flex gap-2">
                <Input
                  variant="code"
                  className="min-w-0 flex-1"
                  aria-label={t('settings.bots.tools.details.argumentLabel', 'Argument {{index}}', {
                    index: index + 1
                  })}
                  value={arg.value}
                  onChange={(event) =>
                    patch({
                      args: draft.args.map((value, i) =>
                        i === index ? { ...value, value: event.target.value } : value
                      )
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t(
                    'settings.bots.tools.details.removeArgumentLabel',
                    'Remove argument {{index}}',
                    { index: index + 1 }
                  )}
                  onClick={() => patch({ args: draft.args.filter((_, i) => i !== index) })}
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
                patch({ args: [...draft.args, { id: createBrowserUuid(), value: '' }] })
              }
            >
              {t('settings.bots.tools.details.addArg', '+ Add argument')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.bots.tools.details.argsHint',
                'One exact argument per row. Spaces and empty arguments are preserved.'
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t('settings.bots.tools.details.env', 'Environment variables')}</Label>
            <BotToolSecretRows
              kind="variable"
              rows={draft.env}
              onChange={(env) => patch({ env })}
            />
          </div>
        </>
      )}
    </div>
  )
}

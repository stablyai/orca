import { useTranslate } from '@/i18n/use-translate'
import React, { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/class-names'
import {
  freeBotToolName,
  type BotToolContext,
  type BotToolDetails,
  type BotToolInput
} from '../../../../shared/bot-tools'
import { parseBotToolPaste } from '../../../../shared/bot-tool-paste'
import { botToolErrorMessage } from './bot-tools-client'
import { botAgentLabel } from './bot-presentation'
import {
  botToolDraftError,
  botToolDraftInput,
  draftFromServer,
  emptyBotToolDraft
} from '../../../../shared/bots/bot-tool-draft'
import { BotToolDetailsFields } from './BotToolDetailsFields'

export function BotToolEditor({
  context,
  host,
  saved,
  taken,
  onSave,
  onCancel,
  onSavingChange
}: {
  context: BotToolContext
  /** The bot's computer when it is a paired server; null for this one. */
  host: string | null
  saved?: BotToolDetails
  taken: ReadonlySet<string>
  onSave: (input: BotToolInput) => Promise<void>
  onCancel: () => void
  onSavingChange?: (saving: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(() =>
    saved ? draftFromServer(saved.server) : emptyBotToolDraft()
  )
  const [source, setSource] = useState('')
  const [manual, setManual] = useState(Boolean(saved))
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(Boolean(saved))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const collision = taken.has(draft.name)
  const invalid = botToolDraftError(draft, context.platform, t, saved)
  const apply = (text: string) => {
    setPending(false)
    setManual(false)
    setError(null)
    try {
      setDraft(draftFromServer(parseBotToolPaste(text, context.platform, t)))
      setPasteError(null)
    } catch (caught) {
      setDraft(emptyBotToolDraft())
      setPasteError(
        caught instanceof Error
          ? caught.message
          : t('bots.tools.pasteInvalid', 'The paste is invalid.')
      )
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy || pending || pasteError || invalid || collision) {
          return
        }
        setBusy(true)
        onSavingChange?.(true)
        setError(null)
        void onSave(botToolDraftInput(draft))
          .catch((caught: unknown) => setError(botToolErrorMessage(caught)))
          .finally(() => {
            setBusy(false)
            onSavingChange?.(false)
          })
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {host
            ? t('settings.bots.tools.details.executionContextOnHost', '{{agent}} · {{host}}', {
                agent: botAgentLabel(context.agent),
                host
              })
            : t('settings.bots.tools.details.executionContext', '{{agent}} · This computer', {
                agent: botAgentLabel(context.agent)
              })}
          <br />
          {t('settings.bots.tools.details.workingFolder', 'Working folder:')}{' '}
          <span className="break-all font-mono">{context.folder}</span>
        </p>
        {!saved ? (
          <div className="space-y-2">
            <Label htmlFor="bot-tool-source">
              {t('settings.bots.tools.details.sourceLabel', 'Server URL or start command')}
            </Label>
            <Input
              id="bot-tool-source"
              autoFocus
              value={source}
              aria-invalid={Boolean(pasteError)}
              placeholder={t('settings.bots.tools.sourcePlaceholder', 'https://… or npx …')}
              onChange={(event) => {
                const text = event.target.value
                setSource(text)
                if (manual) {
                  setPending(true)
                  setPasteError(null)
                } else {
                  apply(text)
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.bots.tools.details.sourceHint',
                'Paste a server URL or start command, or enter the details yourself.'
              )}
            </p>
          </div>
        ) : null}
        {pending ? (
          <div className="space-y-2 rounded-md border border-border p-3" role="status">
            <p className="text-sm">
              {t(
                'settings.bots.tools.details.pasteDecision',
                'You’ve edited the details. Applying this paste will replace those edits.'
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => apply(source)}>
                {t('settings.bots.tools.details.usePaste', 'Use this paste')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPending(false)
                  setSource('')
                  setPasteError(null)
                  setExpanded(true)
                }}
              >
                {t('settings.bots.tools.details.keepDetails', 'Keep my details')}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="!mb-2">
          <Button
            type="button"
            variant="disclosure"
            size="sm"
            aria-expanded={expanded}
            aria-controls="bot-tool-details"
            onClick={() => setExpanded(!expanded)}
            className="-ml-2"
          >
            {t('settings.bots.tools.details.disclosure', 'Edit details')}
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>
        {expanded ? (
          <div id="bot-tool-details">
            <BotToolDetailsFields
              draft={draft}
              focusName={Boolean(saved)}
              onChange={(next) => {
                setDraft(next)
                setManual(true)
                if (!pending) {
                  setSource('')
                }
                setPasteError(null)
                setError(null)
              }}
            />
          </div>
        ) : null}
        {collision ? (
          <div className="space-y-2" role="alert">
            <p className="text-xs text-destructive">
              {t(
                'settings.bots.tools.details.nameTaken',
                'A tool named {{name}} already exists. Choose another name.',
                { name: draft.name }
              )}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setDraft({ ...draft, name: freeBotToolName(draft.name, taken) })
                setManual(true)
                setExpanded(true)
              }}
            >
              {t('settings.bots.tools.details.useName', 'Use {{name}}', {
                name: freeBotToolName(draft.name, taken)
              })}
            </Button>
          </div>
        ) : null}
        {pasteError || error || (manual && invalid) ? (
          <p className="text-xs text-destructive" role="alert">
            {pasteError ?? error ?? invalid}
          </p>
        ) : null}
        {draft.mode === 'command' ? (
          <p className="text-xs text-muted-foreground">
            {host
              ? t(
                  'settings.bots.tools.details.commandWarningOnHost',
                  'The command runs in this bot’s home folder on {{host}}. Adding or saving can start it during the native check. Only add software you trust.',
                  { host }
                )
              : t(
                  'settings.bots.tools.details.commandWarning',
                  'The command runs in this bot’s home folder on this computer. Adding or saving can start it during the native check. Only add software you trust.'
                )}
          </p>
        ) : null}
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('settings.bots.tools.details.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy || pending || Boolean(pasteError) || Boolean(invalid) || collision}
        >
          {busy
            ? t('settings.bots.tools.details.saving', 'Saving…')
            : saved
              ? t('settings.bots.tools.details.save', 'Save changes')
              : t('settings.bots.tools.addButton', 'Add')}
        </Button>
      </div>
    </form>
  )
}

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
  type BotToolInput,
  type BotToolServer
} from '../../../../shared/bot-tools'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
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
import { BotToolPastedServers } from './BotToolPastedServers'

/** The editor outside a bot (Settings › MCP servers): its own words, and no bot facts. */
export type BotToolEditorWords = {
  sourceLabel: string
  sourceHint: string
  nameTaken: (name: string) => string
}

// The source field as a growing box, for a pasted config: the input's look, many lines.
const SOURCE_BOX =
  'block max-h-60 min-h-9 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none [field-sizing:content] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 data-[code=true]:font-mono data-[code=true]:text-xs'

export function BotToolEditor({
  context,
  host,
  saved,
  taken,
  onSave,
  onCancel,
  onSavingChange,
  words,
  parsePaste,
  onSaveMany,
  initial
}: {
  context: BotToolContext | Pick<BotToolContext, 'platform'>
  /** The bot's computer when it is a paired server; null for this one. */
  host: string | null
  saved?: BotToolDetails
  taken: ReadonlySet<string>
  onSave: (input: BotToolInput) => Promise<void>
  onCancel: () => void
  onSavingChange?: (saving: boolean) => void
  words?: BotToolEditorWords
  /** The servers a paste names; one by default. */
  parsePaste?: (text: string) => BotToolServer[]
  /** Adds the servers left checked from a paste that named several. */
  onSaveMany?: (inputs: BotToolInput[]) => Promise<void>
  /** A new server's details to start from, e.g. a catalog app that needs a token header. */
  initial?: BotToolServer
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(() =>
    saved ? draftFromServer(saved.server) : initial ? draftFromServer(initial) : emptyBotToolDraft()
  )
  const [source, setSource] = useState('')
  const [manual, setManual] = useState(Boolean(saved ?? initial))
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(Boolean(saved ?? initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pasteError, setPasteError] = useState<string | null>(null)
  // A paste naming several servers, and the names left checked.
  const [found, setFound] = useState<BotToolServer[] | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  // A name already taken (before, or by an earlier try of this paste) is never added again.
  const picked =
    found?.filter((server) => checked.has(server.name) && !taken.has(server.name)) ?? []
  const many = found !== null && onSaveMany !== undefined
  const collision = !many && taken.has(draft.name)
  const invalid = many
    ? picked.length === 0
      ? t('settings.mcpServers.custom.noneChecked', 'Check a server to add.')
      : null
    : botToolDraftError(draft, context.platform, t, saved)
  const apply = (text: string) => {
    setPending(false)
    setManual(false)
    setError(null)
    setFound(null)
    try {
      const servers = parsePaste ? parsePaste(text) : [parseBotToolPaste(text, context.platform, t)]
      if (servers.length > 1) {
        setFound(servers)
        setChecked(new Set(servers.map((server) => server.name)))
        setDraft(emptyBotToolDraft())
      } else {
        setDraft(servers[0] ? draftFromServer(servers[0]) : emptyBotToolDraft())
      }
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
  const changeSource = (text: string): void => {
    setSource(text)
    if (manual) {
      setPending(true)
      setPasteError(null)
    } else {
      apply(text)
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
        const saving =
          many && found
            ? onSaveMany(picked.map((server) => botToolDraftInput(draftFromServer(server))))
            : onSave(botToolDraftInput(draft))
        void saving
          .catch((caught: unknown) => setError(botToolErrorMessage(caught)))
          .finally(() => {
            setBusy(false)
            onSavingChange?.(false)
          })
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {'folder' in context && !words ? (
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
        ) : null}
        {!saved ? (
          <div className="space-y-2">
            <Label htmlFor="bot-tool-source">
              {words?.sourceLabel ??
                t('settings.bots.tools.details.sourceLabel', 'Server URL or start command')}
            </Label>
            {words ? (
              <ImeTextarea
                id="bot-tool-source"
                autoFocus
                rows={1}
                spellCheck={false}
                value={source}
                data-code={/\n/.test(source)}
                aria-invalid={Boolean(pasteError)}
                placeholder={t('settings.bots.tools.sourcePlaceholder', 'https://… or npx …')}
                className={SOURCE_BOX}
                onChange={(event) => changeSource(event.target.value)}
              />
            ) : (
              <Input
                id="bot-tool-source"
                autoFocus
                value={source}
                aria-invalid={Boolean(pasteError)}
                placeholder={t('settings.bots.tools.sourcePlaceholder', 'https://… or npx …')}
                onChange={(event) => changeSource(event.target.value)}
              />
            )}
            <p hidden={many} className="text-xs text-muted-foreground">
              {words?.sourceHint ??
                t(
                  'settings.bots.tools.details.sourceHint',
                  'Paste a server URL or start command, or enter the details yourself.'
                )}
            </p>
          </div>
        ) : null}
        {many && found ? (
          <BotToolPastedServers
            servers={found}
            checked={checked}
            taken={taken}
            onCheckedChange={(name, on) =>
              setChecked((current) => {
                const next = new Set(current)
                if (on) {
                  next.add(name)
                } else {
                  next.delete(name)
                }
                return next
              })
            }
          />
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
        <div className="!mb-2" hidden={many}>
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
        {expanded && !many ? (
          <div id="bot-tool-details">
            <BotToolDetailsFields
              forBot={!words}
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
              {words
                ? words.nameTaken(draft.name)
                : t(
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
        {draft.mode === 'command' && !words ? (
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
              : many
                ? t('settings.mcpServers.custom.addMany', 'Add {{count}} servers', {
                    count: picked.length
                  })
                : t('settings.bots.tools.addButton', 'Add')}
        </Button>
      </div>
    </form>
  )
}

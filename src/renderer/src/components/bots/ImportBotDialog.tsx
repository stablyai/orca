// Import from another app: pick a bot OpenClaw, Hermes or OpenBot keeps on this computer, or an export the
// old bot made, and create the Orca bot whose first turn brings it over. Laid out like New group.
import React, { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { getRuntimePathBasename } from '../../../../shared/file-access/cross-platform-path'
import { createBot, openBotHomeTab, readHostBots } from '@/lib/bot-catalog'
import { BOT_NAME_MAX_LENGTH, type Bot } from '../../../../shared/bot-types'
import { botInitial } from '../../../../shared/bots/bot-avatar-fallback'
import {
  BOT_IMPORT_APP_LABELS,
  botNameFromExportFolder,
  type BotImportCandidate,
  type BotImportSource
} from '../../../../shared/bots/bot-import'
import { botErrorMessage } from './bot-presentation'
import { BotNameSuggestion, takeSuggestionOnTab } from './BotNameSuggestion'
import { BotRunsOnPicker } from './BotRunsOnPicker'
import { openCreatedBot } from './bot-create-open'
import { useBotImportSources } from './bot-import-sources'
import {
  exportImportPaths,
  ImportBotExportFields,
  type ImportBotExport
} from './ImportBotExportFields'
import { ImportBotHero } from './ImportBotHero'
import { importPickKey, ImportBotSourceList } from './ImportBotSourceList'
import { useBotAgentMenu } from './use-bot-agent-choices'
import { useBotCreateHost } from './bot-create-hosts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { useBotAgentSetup } from './use-bot-agent-setup'
import { useNewBotPicture } from './use-new-bot-picture'

export type ImportPick = { source: BotImportSource; bot: BotImportCandidate }

const NO_EXPORT: ImportBotExport = { folder: null, files: [], reply: '' }

export function ImportBotDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (bot: Bot) => void
}): React.JSX.Element {
  const t = useTranslate()
  const nameId = useId()
  const hostChoice = useBotCreateHost(open)
  const { hostId, blocked } = hostChoice.host
  const read = useBotImportSources(open, hostId)
  const [view, setView] = useState<'pick' | 'export'>('pick')
  const [picked, setPicked] = useState<ImportPick | null>(null)
  const [exported, setExported] = useState<ImportBotExport>(NO_EXPORT)
  // Follows the picked bot until the owner types one.
  const [typedName, setTypedName] = useState<string | null>(null)
  const menu = useBotAgentMenu(hostId, open)
  const { choices } = menu
  const agentSetup = useBotAgentSetup(choices, hostId)
  const picture = useNewBotPicture()
  const [creating, setCreating] = useState(false)

  const picks =
    read.status === 'ready'
      ? read.sources.flatMap((source) => source.bots.map((bot) => ({ source, bot })))
      : []
  // With nothing found there is nothing to pick: straight to asking the old bot.
  const nothingFound = read.status !== 'loading' && picks.length === 0
  const exporting = view === 'export' || nothingFound
  // A pick from another computer's list, before the host changed, gives way to this one's first.
  const pick = exporting
    ? null
    : (picks.find((entry) => picked && importPickKey(entry) === importPickKey(picked)) ??
      picks[0] ??
      null)
  const exportPaths = exportImportPaths(exported)
  // A bot imported before starts unnamed: Update it, or name a new bot to make another.
  const name = typedName ?? (pick && !pick.bot.importedAs ? pick.bot.name : '')
  const trimmedName = name.trim()
  const again = pick?.bot.importedAs && !trimmedName ? pick.bot.importedAs : null
  const existing = again
    ? (readHostBots(hostId).find((bot) => bot.id === again.botId) ?? null)
    : null
  const suggestion =
    exporting && typedName === null && exportPaths
      ? (botNameFromExportFolder(exportPaths.path)?.slice(0, BOT_NAME_MAX_LENGTH) ?? null)
      : null

  // The export's folder is picked on this computer, which a server can't read.
  const missing =
    exporting && hostId !== LOCAL_EXECUTION_HOST_ID
      ? t(
          'bots.import.exportNotOnServer',
          'Export folders on this computer can’t go to {{host}} yet. Copy the folder to {{host}}, or create the bot here.',
          { host: hostChoice.host.label }
        )
      : exporting && !exportPaths
        ? t('bots.import.addFolder', 'Add its folder')
        : !exporting && !pick
          ? null
          : !trimmedName && !again
            ? t('bots.import.nameIt', 'Name your bot')
            : null
  const ready =
    !missing && Boolean(trimmedName) && (exporting ? exportPaths !== null : pick !== null)
  // Enter and the Create button share this, so neither creates before the agents are known.
  const canCreate = ready && !creating && !blocked && choices.length > 0

  const close = (): void => {
    setView('pick')
    setPicked(null)
    setExported(NO_EXPORT)
    setTypedName(null)
    picture.reset()
    agentSetup.reset()
    hostChoice.reset()
    onOpenChange(false)
  }

  const create = async (): Promise<void> => {
    const importFrom = exporting
      ? exportPaths && {
          app: 'export' as const,
          path: exportPaths.path,
          ...(exportPaths.files.length ? { files: exportPaths.files } : {}),
          name: trimmedName,
          ...(exported.reply.trim() ? { reply: exported.reply } : {})
        }
      : pick && {
          app: pick.source.app,
          path: pick.bot.absolutePath,
          agent: pick.bot.agent,
          name: pick.bot.name
        }
    if (!canCreate || !importFrom) {
      return
    }
    setCreating(true)
    try {
      const made = await createBot(hostId, {
        name: trimmedName,
        ...agentSetup.setup,
        avatar: picture.avatar,
        importFrom
      })
      const bot = await picture.saveUpload(made)
      const opened = await openCreatedBot(bot)
      close()
      if (opened) {
        onCreated?.(bot)
      }
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  // The bot an earlier import made gets the new things, instead of a second bot.
  const update = async (): Promise<void> => {
    if (!existing || !pick) {
      return
    }
    close()
    await openBotHomeTab(existing, {
      draft: t('bots.import.updateDraft', 'Bring over anything new from {{name}} in {{app}}.', {
        name: pick.bot.name,
        app: BOT_IMPORT_APP_LABELS[pick.source.app]
      })
    })
  }

  const oldName = exporting
    ? exportPaths &&
      (botNameFromExportFolder(exportPaths.path) ?? getRuntimePathBasename(exportPaths.path))
    : pick?.bot.name
  const old = {
    key: exporting ? (exportPaths?.path ?? 'none') : pick ? importPickKey(pick) : 'none',
    initial: oldName ? botInitial(oldName) : null,
    label: exporting
      ? exportPaths
        ? getRuntimePathBasename(exportPaths.path)
        : t('bots.import.oldBot', 'Old bot')
      : pick
        ? BOT_IMPORT_APP_LABELS[pick.source.app]
        : t('bots.import.oldBot', 'Old bot')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : !creating && close())}>
      <DialogContent scrollable className="sm:max-w-md">
        <DialogHeader className="sm:text-center">
          <DialogTitle>{t('bots.import.title', 'Import from another app')}</DialogTitle>
          <DialogDescription>
            {exporting
              ? t(
                  'bots.import.exportDescription',
                  'Ask your old bot for a copy of itself, then give the copy to your new bot.'
                )
              : t('bots.import.description', 'Your new bot reads the old one and sets itself up.')}
          </DialogDescription>
        </DialogHeader>
        <ImportBotHero old={old} picture={picture} existing={existing} />
        <div>
          <Label htmlFor={nameId} className="sr-only">
            {t('bots.new.name', 'Name')}
          </Label>
          <Input
            id={nameId}
            variant="heading"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            placeholder={
              again
                ? t('bots.import.nameAnother', 'Name a new bot')
                : t('bots.new.namePlaceholder', 'Name your bot')
            }
            onChange={(event) => setTypedName(event.target.value)}
            onKeyDown={(event) => {
              if (!takeSuggestionOnTab(event, suggestion, setTypedName) && event.key === 'Enter') {
                void (again ? update() : create())
              }
            }}
          />
          <BotNameSuggestion suggestion={suggestion} onTake={setTypedName}>
            {again ? (
              <span className="text-xs leading-4 text-muted-foreground">
                {t('bots.import.importedBefore', '{{bot}} came from this bot', {
                  bot: again.name
                })}
              </span>
            ) : null}
          </BotNameSuggestion>
        </div>
        {exporting ? (
          <div className="space-y-2">
            {nothingFound && read.status === 'ready' ? (
              <p className="text-center text-xs text-muted-foreground">
                {t(
                  'bots.import.noneFoundNote',
                  'No bots found in OpenClaw (~/.openclaw), Hermes (~/.hermes) or OpenBot.'
                )}
              </p>
            ) : null}
            <ImportBotExportFields value={exported} onChange={setExported} />
          </div>
        ) : (
          <ImportBotSourceList
            picks={picks}
            loading={read.status === 'loading'}
            picked={pick}
            onPick={(next) => {
              setPicked(next)
              setTypedName(null)
            }}
            onOtherApp={() => {
              setTypedName(null)
              setView('export')
            }}
          />
        )}
        {again ? null : (
          <BotRunsOnPicker
            hostChoice={hostChoice}
            setup={agentSetup.setup}
            model={menu.model}
            choices={choices}
            onSetupChange={agentSetup.setSetup}
            name={name}
          />
        )}
        <DialogFooter className="items-center">
          {missing ? (
            <span className="mr-auto text-xs text-muted-foreground">{missing}</span>
          ) : again ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="mr-auto text-xs text-muted-foreground">
                  {t('bots.import.keysStay', 'Keys and logins stay behind')}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {t(
                  'bots.import.neverCopied',
                  'Keys, tokens and logins are never copied; you reconnect them here.'
                )}
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={creating}
            onClick={() => {
              if (view === 'export' && picks.length > 0) {
                setTypedName(null)
                setView('pick')
              } else {
                close()
              }
            }}
          >
            {view === 'export' && picks.length > 0
              ? t('bots.import.back', 'Back')
              : t('bots.new.cancel', 'Cancel')}
          </Button>
          {again ? (
            <Button type="button" size="sm" disabled={!existing} onClick={() => void update()}>
              {t('bots.import.update', 'Update {{bot}}', { bot: again.name })}
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!canCreate} onClick={() => void create()}>
              {creating
                ? t('bots.new.creating', 'Creating…')
                : trimmedName
                  ? t('bots.import.create', 'Create {{name}}', { name: trimmedName })
                  : t('bots.new.create', 'Create')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

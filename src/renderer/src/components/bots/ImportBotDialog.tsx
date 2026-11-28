// Import from another app: pick a bot OpenClaw, Hermes or OpenBot keeps on this computer, or an export the
// old bot made, and create the Orca bot whose first turn brings it over. One row: picture and name.
import React, { useState } from 'react'
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
import { useTranslate } from '@/i18n/use-translate'
import { createBot, openBotHomeTab, readHostBots } from '@/lib/bot-catalog'
import { BOT_NAME_MAX_LENGTH, type Bot } from '../../../../shared/bot-types'
import {
  BOT_IMPORT_APP_LABELS,
  botNameFromExportFolder,
  type BotImportCandidate,
  type BotImportSource
} from '../../../../shared/bots/bot-import'
import { BotAvatar } from './BotAvatar'
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
import { importPickKey, ImportBotSourceTitle } from './ImportBotSourceTitle'
import { NewBotPictureButton } from './NewBotPictureButton'
import { useBotAgentMenu } from './use-bot-agent-choices'
import { useBotCreateHost } from './bot-create-hosts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { useBotAgentSetup } from './use-bot-agent-setup'
import { useNewBotHostLooks, useNewBotPicture } from './use-new-bot-picture'
import { followedByPicture, useNewBotDialogPicture } from './use-new-bot-generate-face'

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
  const hostChoice = useBotCreateHost(open)
  const { hostId, blocked } = hostChoice.host
  const read = useBotImportSources(open, hostId)
  const [picked, setPicked] = useState<ImportPick | null>(null)
  // With bots found, the owner can still bring over an export instead.
  const [fromExport, setFromExport] = useState(false)
  const [exported, setExported] = useState<ImportBotExport>(NO_EXPORT)
  // Follows the picked bot until the owner types one.
  const [typedName, setTypedName] = useState<string | null>(null)
  const menu = useBotAgentMenu(hostId, open)
  const { choices } = menu
  const agentSetup = useBotAgentSetup(menu, hostId)
  const picture = useNewBotPicture(useNewBotHostLooks(hostId))
  const [creating, setCreating] = useState(false)
  // Kept by the dialog, not its picture button, so a run outlives the popover; only dismissing the dialog
  // ends it.
  const { intake, face } = useNewBotDialogPicture(picture, creating)

  const picks =
    read.status === 'ready'
      ? read.sources.flatMap((source) => source.bots.map((bot) => ({ source, bot })))
      : []
  // With nothing found there is nothing to pick: straight to asking the old bot.
  const nothingFound = read.status !== 'loading' && picks.length === 0
  const exporting = nothingFound || fromExport
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
  const notOnServer =
    exporting && hostId !== LOCAL_EXECUTION_HOST_ID
      ? t(
          'bots.import.exportNotOnServer',
          'Export folders on this computer can’t go to {{host}} yet. Copy the folder to {{host}}, or create the bot here.',
          { host: hostChoice.host.label }
        )
      : null
  const ready =
    !notOnServer && Boolean(trimmedName) && (exporting ? exportPaths !== null : pick !== null)
  // Enter and the Create button share this, so neither creates before the agents are known.
  const canCreate = ready && !creating && !intake.reading && !blocked && choices.length > 0

  const close = (): void => {
    setPicked(null)
    setFromExport(false)
    setExported(NO_EXPORT)
    setTypedName(null)
    intake.dismiss()
    picture.reset()
    // A run handed to the bot made goes on; any other ends here.
    face.reset()
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
    const follow = followedByPicture(face, { hostId, name: trimmedName })
    try {
      // The bot exists once this resolves, whatever opening it does.
      const bot = await follow(
        createBot(hostId, {
          name: trimmedName,
          ...agentSetup.setup,
          avatar: picture.avatar,
          avatarColor: picture.avatarColor,
          avatarOutfit: picture.avatarOutfit,
          importFrom
        }).then(picture.saveUpload)
      )
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : !creating && close())}>
      <DialogContent size="confirm" scrollable showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="min-w-0">
            <ImportBotSourceTitle
              picks={picks}
              picked={pick}
              onPick={(next) => {
                setPicked(next)
                setTypedName(null)
              }}
            />
          </DialogTitle>
          {exporting ? (
            <DialogDescription>
              {t(
                'bots.import.exportDescription',
                'Ask your old bot for a copy of itself, then give the copy to your new bot.'
              )}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {t('bots.import.description', 'Your new bot reads the old one and sets itself up.')}
            </DialogDescription>
          )}
        </DialogHeader>
        <NewBotPictureButton
          picture={picture}
          intake={intake}
          submitted
          generate={face}
          disabled={creating}
          pencil="hover"
          readOnly={
            existing ? (
              <BotAvatar bot={existing} size="large" className="size-16 shrink-0 rounded-[18px]" />
            ) : undefined
          }
        >
          <Input
            aria-label={t('bots.new.name', 'Name')}
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
          {/* Only when it has something to say, so the field stays centred on the picture. */}
          {suggestion || again ? (
            <BotNameSuggestion suggestion={suggestion} onTake={setTypedName} compact>
              {again ? (
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {t('bots.import.importedBefore', '{{bot}} came from this bot', {
                    bot: again.name
                  })}
                </span>
              ) : null}
            </BotNameSuggestion>
          ) : null}
        </NewBotPictureButton>
        {/* New bot's own Computer and Agent fields, so both dialogs pick where a bot runs the same way. */}
        {again ? null : (
          <BotRunsOnPicker
            hostChoice={hostChoice}
            setup={agentSetup.setup}
            model={menu.model}
            choices={choices}
            onSetupChange={agentSetup.setSetup}
            keptPermission={agentSetup.intent}
            chatDefault={agentSetup.chatDefault}
          />
        )}
        {picks.length > 0 ? (
          <button
            type="button"
            className="-mt-1 self-start justify-self-start rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none"
            disabled={creating}
            onClick={() => {
              setTypedName(null)
              setFromExport(!fromExport)
            }}
          >
            {fromExport
              ? t('bots.import.back', 'Back')
              : t('bots.import.fromExport', 'From export')}
          </button>
        ) : null}
        {exporting ? (
          <div className="space-y-2">
            {nothingFound && read.status === 'ready' ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  'bots.import.noneFoundNote',
                  'No bots found in OpenClaw (~/.openclaw), Hermes (~/.hermes) or OpenBot.'
                )}
              </p>
            ) : null}
            <ImportBotExportFields value={exported} onChange={setExported} />
            {notOnServer ? <p className="text-xs text-muted-foreground">{notOnServer}</p> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={creating} onClick={close}>
            {t('bots.new.cancel', 'Cancel')}
          </Button>
          {again ? (
            <Button type="button" size="sm" disabled={!existing} onClick={() => void update()}>
              {t('bots.import.update', 'Update {{bot}}', { bot: again.name })}
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!canCreate} onClick={() => void create()}>
              {creating
                ? t('bots.import.importing', 'Importing…')
                : t('bots.import.import', 'Import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

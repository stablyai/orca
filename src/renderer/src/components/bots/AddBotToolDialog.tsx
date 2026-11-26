import { useTranslate } from '@/i18n/use-translate'
import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { Bot } from '../../../../shared/bot-types'
import type { BotOwnTool, BotToolContext, BotToolDetails } from '../../../../shared/bot-tools'
import {
  botToolErrorMessage,
  readBotToolContext,
  readBotToolDetails,
  saveBotTool
} from './bot-tools-client'
import { useBotTools } from './bot-tool-checks'
import { BotToolEditor } from './BotToolEditor'
import { useBotHostLabel } from './use-bot-host-label'

/** The tool editor once the bot's tool context (and a saved tool) is read; Add by URL hosts it too. */
export function LoadedEditor({
  bot,
  name,
  close,
  onSaved,
  onSavingChange
}: {
  bot: Bot
  name?: string
  close: () => void
  /** After a save, with the tool as the host keeps it; defaults to close. */
  onSaved?: (tool: BotOwnTool) => void
  onSavingChange: (saving: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Names only, to keep a new one free: no check starts the servers.
  const { view } = useBotTools(bot, 'none')
  const [loaded, setLoaded] = useState<{ context: BotToolContext; saved?: BotToolDetails } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const { hostId, id: botId } = bot
  const host = useBotHostLabel(hostId)
  useEffect(() => {
    let live = true
    void Promise.all([
      readBotToolContext({ hostId, id: botId }),
      name ? readBotToolDetails({ hostId, id: botId }, name) : undefined
    ]).then(
      ([context, saved]) => {
        if (live) {
          setLoaded({ context, saved })
        }
      },
      (caught: unknown) => {
        if (live) {
          setError(botToolErrorMessage(caught))
        }
      }
    )
    return () => {
      live = false
    }
  }, [hostId, botId, name])
  if (!loaded || view.status !== 'ready') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {error ??
          (view.status === 'error'
            ? view.message
            : t('settings.bots.tools.details.reading', 'Reading tool details…'))}
      </p>
    )
  }
  const taken = new Set(
    'own' in view.tools
      ? [
          ...view.tools.own.filter((tool) => tool.name !== name).map((tool) => tool.name),
          ...view.tools.inherited.filter((tool) => !tool.plugin).map((tool) => tool.name)
        ]
      : []
  )
  return (
    <BotToolEditor
      {...loaded}
      host={host}
      taken={taken}
      onCancel={close}
      onSavingChange={onSavingChange}
      onSave={async (config) => {
        const tool = await saveBotTool(
          bot,
          config,
          loaded.saved && name ? { name, version: loaded.saved.version } : undefined
        )
        if (onSaved) {
          onSaved(tool)
        } else {
          close()
        }
      }}
    />
  )
}

export function AddBotToolDialog({
  bot,
  open,
  onOpenChange,
  name
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
  name?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) {
          onOpenChange(next)
        }
      }}
    >
      <DialogContent surface="security" scrollable className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {name
              ? t('settings.bots.tools.details.editTitle', 'Edit tool')
              : t('settings.bots.tools.add', 'Add a tool')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.bots.tools.details.scope',
              'Only {{name}} gets it, in addition to your own tools.',
              { name: bot.name }
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <LoadedEditor
            key={name ?? 'new'}
            bot={bot}
            name={name}
            close={() => onOpenChange(false)}
            onSavingChange={setSaving}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

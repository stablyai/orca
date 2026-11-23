// Inline ask-before-switching bar rendered inside NativeChatUsageLimitRow for bot sessions.
import { useEffect, useId, useMemo, useState } from 'react'
import { ArrowLeftRight, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc } from '@/lib/bot-hosts'
import { refreshBotHost } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botModelTargetKey,
  type BotBackupModelEntry,
  type BotBackupStatusResult
} from '../../../../../shared/bots/bot-backup-models'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import { botAgentLabel, botErrorMessage } from '../../bots/bot-presentation'

function formatTarget(entry: BotBackupModelEntry): string {
  const agent = botAgentLabel(entry.agent)
  return entry.model ? `${agent} · ${entry.model}` : agent
}

export function NativeChatBotBackupSwitchRow({
  bot,
  sessionId,
  turnItemId,
  backupState,
  backupResetsAt
}: {
  bot: Bot
  sessionId: string
  turnItemId: string
  backupState: 'switching' | 'ask-backup' | 'backups-exhausted'
  backupResetsAt?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const rememberId = useId()
  const [status, setStatus] = useState<BotBackupStatusResult | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [remember, setRemember] = useState(false)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (backupState !== 'ask-backup') {
      return
    }
    let live = true
    void callBotRpc<BotBackupStatusResult>(bot, 'bots.backup.status', { botId: bot.id })
      .then((next) => {
        if (live) {
          setStatus(next)
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [backupState, bot])

  const readyChoices = useMemo<BotBackupModelEntry[]>(() => {
    if (status) {
      return status.entries.filter((item) => item.state === 'ready').map((item) => item.entry)
    }
    return bot.backupModels?.order ?? []
  }, [bot.backupModels, status])

  const activeChoice = useMemo(
    () => readyChoices.find((entry) => botModelTargetKey(entry) === selectedKey) ?? readyChoices[0],
    [readyChoices, selectedKey]
  )

  if (backupState === 'switching') {
    return (
      <div className="flex items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>
          {t(
            'components.native-chat.usageLimitActions.backupSwitching',
            'Switching to backup model…'
          )}
        </span>
      </div>
    )
  }

  if (backupState === 'backups-exhausted') {
    const resetText =
      backupResetsAt !== undefined ? formatUsageLimitResetClock(backupResetsAt) : null
    return (
      <div className="border-t border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        {resetText
          ? t(
              'components.native-chat.usageLimitActions.backupsExhaustedReset',
              'Primary and backup models hit their usage limits · next reset at {{time}}.',
              { time: resetText }
            )
          : t(
              'components.native-chat.usageLimitActions.backupsExhausted',
              'Primary and backup models hit their usage limits.'
            )}
      </div>
    )
  }

  if (!activeChoice) {
    return null
  }

  const handleSwitch = (): void => {
    setSwitching(true)
    void callBotRpc<{ switched: boolean }>(bot, 'bots.backup.switch', {
      botId: bot.id,
      sessionId,
      turnItemId,
      target: activeChoice,
      ...(remember ? { remember: true } : {})
    })
      .then(() => refreshBotHost(bot.hostId))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setSwitching(false))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-2.5 py-2 text-xs">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Select
          value={botModelTargetKey(activeChoice)}
          disabled={switching}
          onValueChange={setSelectedKey}
        >
          <SelectTrigger
            size="sm"
            aria-label={t(
              'components.native-chat.usageLimitActions.backupSelect',
              'Choose backup model'
            )}
            className="h-7 max-w-60"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {readyChoices.map((entry) => {
              const key = botModelTargetKey(entry)
              return (
                <SelectItem key={key} value={key}>
                  {formatTarget(entry)}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <label
          htmlFor={rememberId}
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
        >
          <Checkbox
            id={rememberId}
            checked={remember}
            disabled={switching}
            onCheckedChange={(checked) => setRemember(checked === true)}
          />
          <span>
            {t(
              'components.native-chat.usageLimitActions.backupRemember',
              'Switch automatically next time'
            )}
          </span>
        </label>
      </div>
      <Button type="button" size="xs" disabled={switching} onClick={handleSwitch}>
        {switching ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <ArrowLeftRight className="size-3.5" />
        )}
        {t('components.native-chat.usageLimitActions.backupSwitchAction', 'Switch & continue')}
      </Button>
    </div>
  )
}

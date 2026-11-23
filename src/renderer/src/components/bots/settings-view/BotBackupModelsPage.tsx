// Bot backup models subpage: ordered failover list, ask-before-switching toggle and live host status.
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc } from '@/lib/bot-hosts'
import { refreshBotHost } from '@/lib/bot-catalog'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { Bot, BotAgent } from '../../../../../shared/bot-types'
import {
  BOT_BACKUP_MODEL_LIMIT,
  addBotBackupModel,
  botModelTargetKey,
  botPrimaryTarget,
  removeBotBackupModel,
  reorderBotBackupModels,
  sameBotModelTarget,
  updateBotBackupModelEffort,
  type BotBackupCatalogOption,
  type BotBackupModelEntry,
  type BotBackupModelStatusEntry,
  type BotBackupStatusResult
} from '../../../../../shared/bots/bot-backup-models'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { botAgentLabel, botErrorMessage } from '../bot-presentation'
import { BotBackupModelOrderRow, formatBackupEntryLabel } from './BotBackupModelOrderRow'
import { BotBackupModelPickerPopover } from './BotBackupModelPickerPopover'
import { SettingsControlsOffContext, SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

const EMPTY_BACKUP_ORDER: readonly BotBackupModelEntry[] = []

type Update = (updates: BotUpdateParams['updates']) => Promise<Bot | null>

export function botBackupModelsSummary(
  bot: Pick<Bot, 'backupModels' | 'activeBackup'>,
  t: ReturnType<typeof useTranslate>
): string {
  if (bot.activeBackup) {
    const label = bot.activeBackup.target.model ?? botAgentLabel(bot.activeBackup.target.agent)
    return t('settings.bots.backupModels.summaryActive', 'On backup · {{model}}', { model: label })
  }
  const count = bot.backupModels?.order.length ?? 0
  if (count === 0) {
    return t('settings.bots.backupModels.summaryOff', 'Off')
  }
  const mode = bot.backupModels?.automatic
    ? t('settings.bots.backupModels.modeAuto', 'Auto')
    : t('settings.bots.backupModels.modeAsk', 'Ask')
  return t('settings.bots.backupModels.summaryCount', '{{count}} · {{mode}}', { count, mode })
}

export type BotBackupModelsContentProps = {
  bot: Pick<Bot, 'id' | 'name' | 'agent' | 'launch' | 'backupModels' | 'activeBackup'>
  status: BotBackupStatusResult | null
  loading: boolean
  returning: boolean
  disabled?: boolean
  onRefresh?: () => void
  onSave: (backupModels: Bot['backupModels'] | null) => void
  onReturnNow: () => void
}

/** Pure presentational body shared by live settings and component fixtures. */
export function BotBackupModelsContent({
  bot,
  status,
  loading,
  returning,
  disabled = false,
  onRefresh,
  onSave,
  onReturnNow
}: BotBackupModelsContentProps): React.JSX.Element {
  const t = useTranslate()
  const primary = useMemo(() => botPrimaryTarget(bot), [bot])
  const primaryLabel = formatBackupEntryLabel(primary)
  const automatic = bot.backupModels?.automatic ?? true
  const order = bot.backupModels?.order ?? EMPTY_BACKUP_ORDER

  const entries: BotBackupModelStatusEntry[] = useMemo(
    () =>
      order.map((entry) => {
        const matched = status?.entries.find((item) => sameBotModelTarget(item.entry, entry))
        return matched ?? { entry, state: 'ready' }
      }),
    [order, status]
  )

  const addableByAgent = useMemo(() => {
    const options = (status?.availableOptions ?? []).filter(
      (option) =>
        option.state !== 'unavailable' &&
        !sameBotModelTarget(option, primary) &&
        !order.some((existing) => sameBotModelTarget(existing, option))
    )
    const grouped = new Map<BotAgent, BotBackupCatalogOption[]>()
    for (const option of options) {
      const list = grouped.get(option.agent) ?? []
      list.push(option)
      grouped.set(option.agent, list)
    }
    return [...grouped.entries()].sort(([a], [b]) =>
      a === primary.agent ? 1 : b === primary.agent ? -1 : 0
    )
  }, [order, primary, status])

  const canAdd = !disabled && order.length < BOT_BACKUP_MODEL_LIMIT && addableByAgent.length > 0

  const handleAdd = (option: BotBackupCatalogOption, effort?: string): void => {
    const next = addBotBackupModel(
      bot.backupModels,
      {
        agent: option.agent,
        ...(option.model ? { model: option.model } : {}),
        ...(effort ? { options: { effort } } : {})
      },
      primary
    )
    onSave(next ?? null)
  }

  return (
    <div className="space-y-4">
      {bot.activeBackup ? (
        <SettingsInsetGroup>
          <SettingsInsetRow
            icon={<RotateCcw />}
            title={t('settings.bots.backupModels.activeTitle', 'Using backup model')}
            detail={
              bot.activeBackup.primaryResetsAt
                ? t(
                    'settings.bots.backupModels.activeDetailReset',
                    'Running on {{backup}}. Returns to {{primary}} after {{time}}.',
                    {
                      backup: formatBackupEntryLabel(bot.activeBackup.target, true),
                      primary: primaryLabel,
                      time: formatUsageLimitResetClock(bot.activeBackup.primaryResetsAt)
                    }
                  )
                : t(
                    'settings.bots.backupModels.activeDetail',
                    'Running on {{backup}}. Returns to {{primary}} when its limit resets.',
                    {
                      backup: formatBackupEntryLabel(bot.activeBackup.target, true),
                      primary: primaryLabel
                    }
                  )
            }
            wrapDetail
            end={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || returning}
                onClick={onReturnNow}
              >
                {returning ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('settings.bots.backupModels.returnNow', 'Return now')}
              </Button>
            }
          />
        </SettingsInsetGroup>
      ) : null}

      <SettingsInsetGroup
        foot={
          automatic
            ? t(
                'settings.bots.backupModels.modeAutoFoot',
                'When {{primary}} hits its usage limit, {{name}} switches to the first available backup automatically.',
                { primary: primaryLabel, name: bot.name }
              )
            : t(
                'settings.bots.backupModels.modeAskFoot',
                'When {{primary}} hits its usage limit, {{name}} pauses and asks in chat before switching.',
                { primary: primaryLabel, name: bot.name }
              )
        }
      >
        <SettingsInsetRow
          icon={<ArrowLeftRight />}
          title={t('settings.bots.backupModels.askBeforeSwitching', 'Ask before switching')}
          end={
            <Switch
              size="compact"
              checked={!automatic}
              disabled={disabled || order.length === 0}
              aria-label={t(
                'settings.bots.backupModels.askBeforeSwitching',
                'Ask before switching'
              )}
              onCheckedChange={(ask) => {
                if (!bot.backupModels) {
                  return
                }
                onSave({ ...bot.backupModels, automatic: !ask })
              }}
            />
          }
        />
      </SettingsInsetGroup>

      <SettingsInsetGroup
        title={t('settings.bots.backupModels.orderTitle', 'Backup order')}
        foot={t(
          'settings.bots.backupModels.returnFoot',
          '{{name}} automatically returns to {{primary}} once its usage limit resets.',
          { name: bot.name, primary: primaryLabel }
        )}
      >
        {entries.length === 0 ? (
          <div className="px-3 py-3 text-xs leading-4 text-muted-foreground">
            {t(
              'settings.bots.backupModels.empty',
              'No backup models configured. Add models from this or another installed agent to keep {{name}} running when {{primary}} hits its usage limit.',
              { name: bot.name, primary: primaryLabel }
            )}
          </div>
        ) : (
          entries.map((item, index) => (
            <BotBackupModelOrderRow
              key={botModelTargetKey(item.entry)}
              item={item}
              index={index}
              total={entries.length}
              catalogOption={status?.availableOptions.find((opt) =>
                sameBotModelTarget(opt, item.entry)
              )}
              disabled={disabled}
              onChangeEffort={(effort) =>
                onSave(updateBotBackupModelEffort(bot.backupModels, index, effort) ?? null)
              }
              onMoveUp={() =>
                onSave(reorderBotBackupModels(bot.backupModels, index, index - 1) ?? null)
              }
              onMoveDown={() =>
                onSave(reorderBotBackupModels(bot.backupModels, index, index + 1) ?? null)
              }
              onRemove={() => onSave(removeBotBackupModel(bot.backupModels, index) ?? null)}
            />
          ))
        )}

        {order.length < BOT_BACKUP_MODEL_LIMIT ? (
          <BotBackupModelPickerPopover
            addableByAgent={addableByAgent}
            canAdd={canAdd}
            loading={loading}
            onOpen={onRefresh}
            onSelect={handleAdd}
          />
        ) : null}
      </SettingsInsetGroup>
    </div>
  )
}

export function BotBackupModelsPage({
  bot,
  update
}: {
  bot: Bot
  update: Update
}): React.JSX.Element {
  const controlsOff = useContext(SettingsControlsOffContext)
  const [status, setStatus] = useState<BotBackupStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [returning, setReturning] = useState(false)

  const readStatus = useCallback(async () => {
    setLoading(true)
    try {
      const next = await callBotRpc<BotBackupStatusResult>(bot, 'bots.backup.status', {
        botId: bot.id
      })
      setStatus(next)
    } catch {
      // Keep last known status when offline or unavailable.
    }
    setLoading(false)
  }, [bot])

  useEffect(() => {
    if (controlsOff) {
      setLoading(false)
      return
    }
    void readStatus()
    return onBotsChanged(() => void readStatus(), bot.hostId, { kinds: ['settings'] })
  }, [
    controlsOff,
    readStatus,
    bot.hostId,
    bot.backupModels,
    bot.activeBackup,
    bot.agent,
    bot.launch
  ])

  const handleSave = (backupModels: Bot['backupModels'] | null): void => {
    void update({ backupModels })
  }

  const handleReturnNow = (): void => {
    setReturning(true)
    void callBotRpc<{ returned: boolean }>(bot, 'bots.backup.return', { botId: bot.id })
      .then(() => refreshBotHost(bot.hostId))
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setReturning(false))
  }

  return (
    <BotBackupModelsContent
      bot={bot}
      status={status}
      loading={loading}
      returning={returning}
      disabled={controlsOff}
      onRefresh={() => void readStatus()}
      onSave={handleSave}
      onReturnNow={handleReturnNow}
    />
  )
}

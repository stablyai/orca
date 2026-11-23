// Bot settings: how long an untouched item waits before the Items tab moves it to Stale.
import { Hourglass } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import {
  BOT_ITEMS_STALE_CHOICES as CHOICES,
  type BotItemsStale
} from '../../../../../shared/bots/bot-items-stale'
import { BOT_ITEM_DEFAULT_STALE_DAYS } from '../../../../../shared/bots/bot-items'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

export function BotItemsSettingsGroup({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsInsetGroup title={t('bots.settingsView.items', 'Items')}>
      <BotItemsStaleRow bot={bot} update={update} />
    </SettingsInsetGroup>
  )
}

function BotItemsStaleRow({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element {
  const t = useTranslate()
  const value = bot.itemsStale ?? BOT_ITEM_DEFAULT_STALE_DAYS
  const title = t('bots.settingsView.itemsStale.shortTitle', 'Stale after')
  const choiceLabel = t('bots.settingsView.itemsStale.title', 'Mark items stale after')
  const label = (choice: BotItemsStale): string =>
    choice === 'never'
      ? t('bots.settingsView.itemsStale.never', 'Never')
      : t('bots.settingsView.itemsStale.days', '{{days}} days', { days: choice })
  return (
    <SettingsInsetRow
      icon={<Hourglass />}
      title={title}
      end={
        <Select
          value={String(value)}
          onValueChange={(next) => {
            const choice = CHOICES.find((entry) => String(entry) === next)
            if (choice !== undefined) {
              void update({ itemsStale: choice })
            }
          }}
        >
          <SelectTrigger size="xs" aria-label={choiceLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {label(choice)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}

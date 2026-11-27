// Bot settings: the context percent at which a Claude Code bot's chats compact on their own.
import { Shrink } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { SettingsInsetRow } from './BotSettingsRows'

const PRESET_PERCENTS = [30, 40, 50, 60, 70, 80, 90] as const
const DEFAULT_CHOICE = 'default'

export function BotAutoCompactRow({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element {
  const t = useTranslate()
  const saved = bot.autoCompactPercent ?? undefined
  // A percent set from the CLI stays pickable even when it is not a preset.
  const percents = [...new Set([...PRESET_PERCENTS, ...(saved !== undefined ? [saved] : [])])].sort(
    (a, b) => a - b
  )
  const title = t('bots.settingsView.autoCompact.title', 'Auto compact')
  return (
    <SettingsInsetRow
      icon={<Shrink />}
      title={title}
      end={
        <Select
          value={saved === undefined ? DEFAULT_CHOICE : String(saved)}
          onValueChange={(next) => {
            void update({ autoCompactPercent: next === DEFAULT_CHOICE ? null : Number(next) })
          }}
        >
          <SelectTrigger size="xs" aria-label={title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_CHOICE}>
              {t('bots.settingsView.autoCompact.default', 'Default')}
            </SelectItem>
            {percents.map((percent) => (
              <SelectItem key={percent} value={String(percent)}>
                {t('bots.settingsView.autoCompact.percent', '{{percent}}%', { percent })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}

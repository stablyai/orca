// Which setup of the bot's agent its chats run as: the agent itself or one of its saved copies.
import { Check } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { useAgentCopiesForMenu } from '@/components/agent/launch-menu/AgentCopyMenuItems'
import { RadioGroup, RadioGroupItemSlot } from '@/components/ui/radio-group'
import {
  SettingsInsetGroup,
  SettingsInsetRow
} from '@/components/bots/settings-view/BotSettingsRows'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'

export function BotAgentCopySetting({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const copies = useAgentCopiesForMenu().filter((copy) => copy.agent === bot.agent)
  if (copies.length === 0 && !bot.agentCopy) {
    return null
  }
  const agentLabel = getAgentCatalog().find((entry) => entry.id === bot.agent)?.label ?? bot.agent
  const choices = [
    { id: null, title: agentLabel },
    ...copies.map((copy) => ({ id: copy.id, title: copy.name }))
  ]
  // Copy ids carry a dot, so the agent's own id never collides with one.
  const value = bot.agentCopy ?? bot.agent
  return (
    <SettingsInsetGroup
      title={t('settings.bots.runsAs', 'Runs as')}
      foot={t(
        'settings.bots.runsAsDescription',
        "New conversations start with this copy's command, arguments and environment."
      )}
    >
      <RadioGroup
        aria-label={t('settings.bots.runsAs', 'Runs as')}
        value={value}
        onValueChange={(next) => void update({ agentCopy: next === bot.agent ? null : next })}
        layout="rows"
      >
        {choices.map((choice) => {
          const id = choice.id ?? bot.agent
          return (
            <RadioGroupItemSlot key={id} value={id}>
              <button
                type="button"
                className="block w-full text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
              >
                <SettingsInsetRow
                  title={choice.title}
                  {...(choice.id ? { detail: choice.id } : {})}
                  end={
                    id === value ? <Check aria-hidden className="size-4 text-foreground" /> : null
                  }
                />
              </button>
            </RadioGroupItemSlot>
          )
        })}
      </RadioGroup>
    </SettingsInsetGroup>
  )
}

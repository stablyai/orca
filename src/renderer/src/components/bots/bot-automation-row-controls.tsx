// What the Automations section's rows share: their kind icon's style, the paused state, and Pause/Resume as
// a row button and a menu item.
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { botErrorMessage } from './bot-presentation'
import { BotRowIconButton, type BotRowMenuItem, type BotRowState } from './BotPanelRow'

export const ICON = 'size-3.5 text-muted-foreground'

export function updateBotReporting(bot: Bot, updates: BotUpdateParams['updates']): void {
  void updateBot(bot, updates).catch((error: unknown) => toast.error(botErrorMessage(error)))
}

export const paused = (t: Translate): BotRowState => ({
  kind: 'paused',
  label: t('bots.automations.paused', 'Paused')
})

/** "Won’t run: needs the Slack connector" as a state and its reason; a label with no colon is all state. */
export function wontFireState(label: string): BotRowState {
  const at = label.indexOf(': ')
  if (at === -1) {
    return { kind: 'alert', label }
  }
  const reason = label.slice(at + 2)
  return {
    kind: 'alert',
    label: label.slice(0, at),
    reason: reason.charAt(0).toLocaleUpperCase() + reason.slice(1)
  }
}

/** Pause or Resume, as the row's button and as its menu item. */
export function pauseResume(
  t: Translate,
  on: boolean,
  set: (on: boolean) => void,
  disabled = false
): BotRowMenuItem {
  return on
    ? {
        icon: <Pause />,
        label: t('bots.automations.pauseShort', 'Pause'),
        onSelect: () => set(false),
        disabled
      }
    : {
        icon: <Play />,
        label: t('bots.automations.resumeShort', 'Resume'),
        onSelect: () => set(true),
        disabled
      }
}

export function PauseResumeButton({ item }: { item: BotRowMenuItem }): React.JSX.Element {
  return (
    <BotRowIconButton label={item.label} disabled={item.disabled} onClick={item.onSelect}>
      {item.icon}
    </BotRowIconButton>
  )
}

import { botCodedText } from '../../../../../shared/bots/bot-failure-copy'
import { useState } from 'react'
import { useBotActivity } from '@/components/bots/use-bot-activity'
import { lookNow } from '@/components/bots/bot-up-next-actions'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { formatAutomationDateTime } from '@/components/automations/automation-page-parts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botForLookAround,
  botLookAround,
  LOOK_AROUND_EVERY_CHOICES,
  LOOK_AROUND_FOCUS_MAX_LENGTH,
  lookAroundSupported,
  type BotLookAround,
  type LookAroundEvery,
  type UpNextState
} from '../../../../../shared/bots/bot-look-around'
import { lookAroundEveryLabel } from '../../../../../shared/bots/bot-look-around-every-label'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { Switch } from '@/components/ui/switch'
import { lookAroundLine } from '@/components/bots/bot-settings-row-states'
import {
  SettingsRow,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import { useSaveOnClose } from './use-save-on-close'

function isEvery(value: string): value is LookAroundEvery {
  return LOOK_AROUND_EVERY_CHOICES.some((choice) => choice === value)
}

/** "Today, 12:04 PM · took 3 min · 4 suggestions", or when the first look comes. */
function lastLookedText(state: UpNextState | undefined, count: number): string {
  if (!state?.lastLookedAt) {
    return state?.nextAt
      ? translate('settings.bots.lookAround.firstLook', 'First look: {{time}}', {
          time: formatAutomationDateTime(state.nextAt)
        })
      : translate(
          'settings.bots.lookAround.notArmed',
          'The first look comes a few hours after your first conversation.'
        )
  }
  const minutes = Math.max(1, Math.round((state.tookMs ?? 0) / 60_000))
  return [
    formatAutomationDateTime(state.lastLookedAt),
    translate('settings.bots.lookAround.took', 'took {{value}} min', { value: minutes }),
    translate('settings.bots.lookAround.suggestions', '{{value}} suggestions', { value: count })
  ].join(' · ')
}

export function BotLookAroundSection({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const setting = botLookAround(bot)
  const { upNext } = useBotActivity(bot)
  const [focus, setFocus] = useState(setting.focus)
  const [savedFocus, setSavedFocus] = useState(setting.focus)
  if (setting.focus !== savedFocus) {
    // Changed elsewhere (the bot, asked in chat): follow it unless the owner is typing.
    setSavedFocus(setting.focus)
    if (focus.trim() === savedFocus) {
      setFocus(setting.focus)
    }
  }
  // Only the changed field, so quick edits and the bot's own chat edits never undo each other.
  const change = (next: Partial<BotLookAround>): void => {
    void update({ lookAround: next })
  }
  const typedFocus = focus.trim()
  useSaveOnClose(typedFocus !== setting.focus ? () => change({ focus: typedFocus }) : null)

  if (!lookAroundSupported(bot.agent)) {
    return null
  }
  const state = upNext?.state
  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={t('settings.bots.lookAround.title', 'Look around')}
        description={lookAroundLine(setting, state?.lastLookedAt)}
        action={
          <Switch
            checked={setting.on}
            onCheckedChange={() => change({ on: !setting.on })}
            aria-label={t('settings.bots.lookAround.title', 'Look around')}
          />
        }
      />
      {setting.on ? null : (
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.bots.lookAround.onDescription',
            'Reads connected apps and projects to suggest next steps. Read-only; it can’t post or change files.',
            { name: bot.name }
          )}
        </p>
      )}
      {setting.on ? (
        <>
          <SettingsRow
            label={t('settings.bots.lookAround.every', 'How often')}
            description={t(
              'settings.bots.lookAround.everyDescription',
              'Each look uses your {{agent}} plan, like a short chat.',
              { agent: botAgentLabel(botForLookAround(bot).agent) }
            )}
            control={
              <Select
                value={setting.every}
                onValueChange={(value) => {
                  if (isEvery(value)) {
                    change({ every: value })
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-64 max-w-full"
                  aria-label={t('settings.bots.lookAround.every', 'How often')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOK_AROUND_EVERY_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {lookAroundEveryLabel(choice, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsSwitchRow
            label={t('settings.bots.lookAround.weekdaysOnly', 'Weekdays only')}
            checked={setting.weekdaysOnly}
            onChange={() => change({ weekdaysOnly: !setting.weekdaysOnly })}
          />
          <div className="space-y-2 py-3">
            <Label htmlFor={`bot-look-for-${bot.id}`}>
              {t('settings.bots.lookAround.focus', 'Look for')}
            </Label>
            <Input
              id={`bot-look-for-${bot.id}`}
              className="h-9"
              value={focus}
              maxLength={LOOK_AROUND_FOCUS_MAX_LENGTH}
              placeholder={t(
                'settings.bots.lookAround.focusPlaceholder',
                'PRs waiting on me, questions in #eng, issues due this week'
              )}
              onChange={(event) => setFocus(event.target.value)}
              onBlur={() => {
                if (typedFocus !== setting.focus) {
                  change({ focus: typedFocus })
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.currentTarget.blur()
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'settings.bots.lookAround.focusDescription',
                'Optional. Leave empty to look for anything waiting on you.',
                { name: bot.name }
              )}
            </p>
          </div>
          <SettingsRow
            label={t('settings.bots.lookAround.lastLooked', 'Last looked')}
            description={
              <>
                {lastLookedText(state, upNext?.items.length ?? 0)}
                {state?.error ? (
                  <>
                    <br />
                    {botCodedText(state.error, state.failure, t)}
                  </>
                ) : null}
                <br />
                {t(
                  'settings.bots.lookAround.whileRunning',
                  'Orca must be running on this computer.',
                  { name: bot.name }
                )}
              </>
            }
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={state?.running === true || bot.paused}
                onClick={() => void lookNow(bot)}
              >
                {state?.running
                  ? t('settings.bots.lookAround.looking', 'Looking…')
                  : t('bots.upNext.lookNow', 'Look now')}
              </Button>
            }
          />
        </>
      ) : null}
    </section>
  )
}

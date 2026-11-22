import { botCodedText } from '../../../../../shared/bots/bot-failure-copy'
import { useState } from 'react'
import { BotTidyUpReview, tidyUpRunMeta } from '@/components/bots/BotTidyUpReview'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { useBotTidyUp } from '@/components/bots/use-bot-tidy-up'
import { Button } from '@/components/ui/button'
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
import { lookAroundSupported } from '../../../../../shared/bots/bot-look-around'
import {
  botTidyUp,
  TIDY_UP_EVERY_CHOICES,
  tidyUpChangeCount,
  type BotTidyUp,
  type TidyUpEvery
} from '../../../../../shared/bots/bot-tidy-up'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { Switch } from '@/components/ui/switch'
import { tidyUpLine } from '@/components/bots/bot-settings-row-states'
import { SettingsRow, SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'

function isEvery(value: string): value is TidyUpEvery {
  return TIDY_UP_EVERY_CHOICES.some((choice) => choice === value)
}

const everyLabel = (every: TidyUpEvery): string =>
  every === 'night'
    ? translate('settings.bots.tidyUp.everyNight', 'Each night after 3 AM')
    : translate('settings.bots.tidyUp.everyWeek', 'Once a week, after 3 AM')

/** Settings › Bots › Memory upkeep: the nightly Tidy-up, its last run, and Tidy now. */
export function BotTidyUpSection({
  bot,
  update
}: {
  bot: Bot
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const setting = botTidyUp(bot)
  const { view, tidyNow, undo } = useBotTidyUp(bot)
  const [reviewing, setReviewing] = useState(false)
  // Only the changed field, so quick edits never undo each other.
  const change = (next: Partial<BotTidyUp>): void => {
    void update({ tidyUp: next })
  }
  if (!lookAroundSupported(bot.agent)) {
    return null
  }
  const last = view?.last ?? null
  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={t('settings.bots.tidyUp.title', 'Memory upkeep')}
        description={tidyUpLine(setting, last?.at)}
        action={
          <Switch
            checked={setting.on}
            onCheckedChange={() => change({ on: !setting.on })}
            aria-label={t('settings.bots.tidyUp.title', 'Memory upkeep')}
          />
        }
      />
      {view?.turnedOff || !setting.on ? (
        <p className="text-xs text-muted-foreground">
          {view?.turnedOff
            ? t(
                'settings.bots.tidyUp.turnedOff',
                'Turned off after 10 tidy-ups in a row failed. Last: {{error}}',
                { error: view.turnedOff }
              )
            : t(
                'settings.bots.tidyUp.onDescription',
                'Merges repeats, marks facts that changed, files details into topic files and moves old lines to memory/archive.md. Changes memory files only; it can’t post or touch projects.'
              )}
        </p>
      ) : null}
      {setting.on ? (
        <>
          <SettingsRow
            label={t('settings.bots.tidyUp.every', 'How often')}
            description={t(
              'settings.bots.tidyUp.everyDescriptionAwake',
              'If this computer is asleep then, it runs once it is awake. Only after nights with new chats. Each tidy-up uses your {{agent}} plan, like a short chat.',
              { agent: botAgentLabel(bot.agent) }
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
                  aria-label={t('settings.bots.tidyUp.every', 'How often')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIDY_UP_EVERY_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {everyLabel(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={t('settings.bots.tidyUp.lastTidied', 'Last tidied')}
            description={
              <>
                {last ? (
                  <>
                    {tidyUpRunMeta(last, false)}
                    {' · '}
                    {t('settings.bots.tidyUp.changes', '{{count}} changes', {
                      count: tidyUpChangeCount(last)
                    })}
                    {' · '}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setReviewing(true)}
                    >
                      {t('settings.bots.tidyUp.review', 'Review')}
                    </button>
                  </>
                ) : (
                  t(
                    'settings.bots.tidyUp.never',
                    'Not yet. The first comes after a night with new chats.'
                  )
                )}
                {view?.error && !view.turnedOff ? (
                  <>
                    <br />
                    {botCodedText(view.error, view.failure, t)}
                  </>
                ) : null}
                <br />
                {t('settings.bots.tidyUp.whileRunning', 'Orca must be running on this computer.')}
              </>
            }
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={view?.running === true || bot.paused}
                onClick={() => void tidyNow()}
              >
                {view?.running
                  ? t('settings.bots.tidyUp.tidying', 'Tidying…')
                  : t('settings.bots.tidyUp.now', 'Tidy now')}
              </Button>
            }
          />
        </>
      ) : null}
      {last ? (
        <BotTidyUpReview
          run={last}
          open={reviewing}
          onOpenChange={setReviewing}
          onUndo={() => last.rowId && void undo(last.rowId)}
        />
      ) : null}
    </section>
  )
}

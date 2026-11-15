import { useRef, useState } from 'react'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { useBotActivity } from '@/components/bots/use-bot-activity'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import {
  foreignZone,
  lookAroundPresetLabel,
  lookAroundScheduleLine
} from '@/components/bots/bot-look-around-copy'
import { LookStatusToken } from '@/components/bots/LookStatusToken'
import { useBotHostLabel } from '@/components/bots/use-bot-host-label'
import {
  useLookAroundReadError,
  refreshLookAroundStatus,
  useLookAroundFailing,
  useLookAroundStatus
} from '@/components/bots/use-look-around-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botLookAround,
  LOOK_AROUND_FOCUS_MAX_LENGTH,
  LOOK_AROUND_PRESETS,
  lookAroundSupported,
  type LookAroundPreset
} from '../../../../../shared/bots/bot-look-around'
import {
  lookAroundTimes,
  lookAroundTimesProblem
} from '../../../../../shared/bots/bot-look-around-times'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { Switch } from '@/components/ui/switch'
import { lookAroundLine } from '@/components/bots/bot-settings-row-states'
import {
  SettingsRow,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import { useSaveOnClose } from './use-save-on-close'
import { BotLookAroundStatus } from './BotLookAroundStatus'
import { BotLookAroundTimes } from './BotLookAroundTimes'
import { BotLookAroundZone } from './BotLookAroundZone'
import { useLookAroundEdit } from './use-look-around-edit'

const CUSTOM = 'custom'

function isPreset(value: string): value is LookAroundPreset {
  return LOOK_AROUND_PRESETS.some((choice) => choice === value)
}

function sameTimes(a: readonly string[], b: readonly string[] | undefined): boolean {
  return b !== undefined && a.length === b.length && [...a].sort().join() === [...b].sort().join()
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
  // Null from a host too old for custom times: it would save them as every 4 hours.
  const status = useLookAroundStatus(bot)
  const readError = useLookAroundReadError(bot)
  const failing = useLookAroundFailing(bot)
  const hostLabel = useBotHostLabel(bot.hostId)
  const [focus, setFocus] = useState(setting.focus)
  const [savedFocus, setSavedFocus] = useState(setting.focus)
  const [draftTimes, setDraftTimes] = useState<string[] | null>(null)
  const latestDraft = useRef<string[] | null>(null)
  const { change, heldEdit, asking, answerZone, dismissZone } = useLookAroundEdit(
    bot,
    update,
    status,
    readError
  )
  const changeDraft = (draft: string[] | null): void => {
    latestDraft.current = draft
    setDraftTimes(draft)
  }
  if (setting.focus !== savedFocus) {
    // Changed elsewhere (the bot, asked in chat): follow it unless the owner is typing.
    setSavedFocus(setting.focus)
    if (focus.trim() === savedFocus) {
      setFocus(setting.focus)
    }
  }
  const hostZone = status?.upNext.hostTimeZone
  const typedFocus = focus.trim()
  const unsavedTimes =
    draftTimes !== null && !sameTimes(draftTimes, setting.times) ? draftTimes : null
  const shown = { ...setting, ...heldEdit }
  useSaveOnClose(() => {
    if (typedFocus !== setting.focus) {
      change({ focus: typedFocus })
    }
    const times = latestDraft.current
    if (
      times &&
      !sameTimes(times, setting.times) &&
      shown.every === CUSTOM &&
      !heldEdit &&
      !lookAroundTimesProblem(times)
    ) {
      change({ times })
    }
  })

  if (!lookAroundSupported(bot.agent)) {
    return null
  }
  const state = status?.upNext ?? upNext?.state
  const where = hostLabel ?? t('settings.bots.lookAround.thisComputer', 'this computer')
  const zone = foreignZone(state?.timeZone)
  // The host lists an off bot as failing only when its failures turned it off.
  const turnedOff = !setting.on && failing > 0
  const offerCustom = status !== null || setting.every === CUSTOM

  return (
    <section className="@container space-y-4">
      <SettingsSubsectionHeader
        title={t('settings.bots.lookAround.title', 'Look around')}
        description={lookAroundLine(setting, state?.lastLookedAt, zone)}
        action={
          <Switch
            checked={setting.on}
            onCheckedChange={() => change({ on: !setting.on })}
            aria-label={t('settings.bots.lookAround.title', 'Look around')}
          />
        }
      />
      {setting.on ? null : (
        <div className="space-y-2 text-xs text-muted-foreground">
          {turnedOff ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
              <LookStatusToken severity="need">
                {t('settings.bots.lookAround.turnedOff', 'Turned off')}
              </LookStatusToken>
              <span className="min-w-0 flex-1">
                {t(
                  'settings.bots.lookAround.turnedOffWhy',
                  'Look around turned itself off after {{count}} failed looks in a row. Your schedule is kept.',
                  { count: failing }
                )}
              </span>
              <Button variant="outline" size="sm" onClick={() => change({ on: true })}>
                {t('settings.bots.lookAround.turnOn', 'Turn on')}
              </Button>
            </div>
          ) : null}
          <p>
            {t(
              'settings.bots.lookAround.onDescription',
              'Reads connected apps and projects to suggest next steps. Read-only; it can’t post or change files.',
              { name: bot.name }
            )}
          </p>
          <p>
            {t('settings.bots.lookAround.whenOn', 'When on: {{schedule}}', {
              schedule: lookAroundScheduleLine(setting, zone)
            })}
          </p>
        </div>
      )}
      {setting.on ? (
        <>
          {readError ? (
            <p className="text-xs text-muted-foreground" role="status">
              {hasRuntimeRpcErrorCode(readError, 'method_not_found') ? (
                t(
                  'settings.bots.lookAround.hostTooOld',
                  'This bot’s computer runs an older Orca. Update it to edit custom times or a time zone.'
                )
              ) : (
                <>
                  {t(
                    'settings.bots.lookAround.readFailed',
                    'Couldn’t read this bot’s schedule. Your saved settings are kept.'
                  )}{' '}
                  <Button
                    variant="link"
                    size="inlineText"
                    onClick={() => refreshLookAroundStatus(bot)}
                  >
                    {t('common.retry', 'Retry')}
                  </Button>
                </>
              )}
            </p>
          ) : null}
          <SettingsRow
            label={t('settings.bots.lookAround.every', 'How often')}
            description={t(
              'settings.bots.lookAround.everyDescription',
              'Each look uses your {{agent}} plan, like a short chat.',
              { agent: botAgentLabel(bot.agent) }
            )}
            control={
              <Select
                value={shown.every}
                onValueChange={(value) => {
                  if (isPreset(value)) {
                    changeDraft(null)
                    change({ every: value })
                  } else if (value === CUSTOM) {
                    // Opens with the schedule it had, so "each morning" becomes one 8:00 AM row.
                    change(
                      setting.times?.length
                        ? { every: CUSTOM }
                        : {
                            times: lookAroundTimes(setting).length
                              ? lookAroundTimes(setting)
                              : ['09:00']
                          }
                    )
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
                  {LOOK_AROUND_PRESETS.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {lookAroundPresetLabel(choice)}
                    </SelectItem>
                  ))}
                  {offerCustom ? (
                    <>
                      <SelectSeparator />
                      <SelectItem value={CUSTOM}>
                        {t('settings.bots.lookAround.customTimes', 'Custom times…')}
                      </SelectItem>
                    </>
                  ) : null}
                </SelectContent>
              </Select>
            }
          />
          {shown.every === CUSTOM ? (
            <BotLookAroundTimes
              saved={shown.times ?? []}
              initialDraft={draftTimes}
              onSave={(times) => change({ times })}
              onDraftChange={changeDraft}
            />
          ) : null}
          {status ? (
            <BotLookAroundZone
              setting={setting}
              hostTimeZone={hostZone}
              hostLabel={hostLabel}
              asking={asking}
              unreadable={status.upNext.zoneUnreadable === true}
              onChange={(timezone) => (heldEdit ? answerZone(timezone) : change({ timezone }))}
              onNotNow={dismissZone}
            />
          ) : null}
          <SettingsSwitchRow
            label={t('settings.bots.lookAround.weekdaysOnly', 'Weekdays only')}
            checked={setting.weekdaysOnly}
            onChange={() => change({ weekdaysOnly: !setting.weekdaysOnly })}
          />
          <BotLookAroundStatus
            bot={bot}
            setting={setting}
            state={state}
            suggestions={upNext?.items.length ?? 0}
            unsaved={unsavedTimes !== null || heldEdit !== null}
            where={where}
            needsYou={failing > 0}
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
        </>
      ) : null}
    </section>
  )
}

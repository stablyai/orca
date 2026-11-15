// Which clock Look around's times are read on: always said in Settings, changeable, and asked once
// when the viewer's zone isn't the host's and none is saved yet.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { timeZoneName, viewerTimeZone } from '@/components/bots/bot-look-around-copy'
import { useTranslate } from '@/i18n/use-translate'
import type { BotLookAround } from '../../../../../shared/bots/bot-look-around'
import { LOOK_AROUND_HOST_CLOCK } from '../../../../../shared/bots/bot-look-around-times'

const HOST_CLOCK = '__host__'

function allZones(): string[] {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone')]
  } catch {
    return []
  }
}

export function BotLookAroundZone({
  setting,
  hostTimeZone,
  hostLabel,
  asking,
  unreadable,
  onChange,
  onNotNow
}: {
  setting: BotLookAround
  /** From the host; undefined while it hasn't answered. */
  hostTimeZone: string | undefined
  /** The paired server's name; null for this computer. */
  hostLabel: string | null
  /** A schedule edit waits on which zone the owner means. */
  asking: boolean
  /** The host can't read the saved zone, so the times follow its clock until one is picked. */
  unreadable?: boolean
  /** A zone name, or null for the host's own clock. */
  onChange: (zone: string | null) => void
  /** Leaves the question unanswered: nothing saves, and it's asked again on the next edit. */
  onNotNow: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [picking, setPicking] = useState(false)
  const viewer = viewerTimeZone()
  // A saved zone of its own; "host" is the owner choosing the host's clock.
  const ownZone =
    setting.timezone && setting.timezone !== LOOK_AROUND_HOST_CLOCK ? setting.timezone : undefined
  const zone = ownZone ?? hostTimeZone
  if (!zone) {
    return null
  }
  const where = hostLabel ?? t('settings.bots.lookAround.thisComputer', 'this computer')
  return (
    <div className="space-y-2 pb-3 text-xs text-muted-foreground" aria-live="polite">
      <p>
        {unreadable && ownZone && hostTimeZone
          ? t(
              'settings.bots.lookAround.zoneUnreadable',
              'The saved time zone "{{saved}}" can’t be read on {{where}}, so times follow its clock ({{zone}}) until you pick one.',
              { saved: ownZone, where, zone: timeZoneName(hostTimeZone) }
            )
          : ownZone
            ? t('settings.bots.lookAround.zoneSaved', 'Times are in {{zone}}.', {
                zone: timeZoneName(zone)
              })
            : t(
                'settings.bots.lookAround.zoneHost',
                'Times are in {{zone}}, the clock of {{where}}.',
                {
                  zone: timeZoneName(zone),
                  where
                }
              )}{' '}
        <Button
          variant="link"
          size="inlineText"
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
        >
          {t('settings.bots.lookAround.zoneChange', 'Change')}
        </Button>
      </p>
      {asking && hostTimeZone ? (
        <div
          role="group"
          aria-label={t('settings.bots.lookAround.zoneAsk', 'Which time zone are these times in?')}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
        >
          <span className="text-foreground">
            {t(
              'settings.bots.lookAround.zoneAskSave',
              'Which time zone are these times in? Pick one to save your change.'
            )}
          </span>
          <Button variant="outline" size="sm" onClick={() => onChange(viewer)}>
            {t('settings.bots.lookAround.zoneMine', '{{zone}} (you)', {
              zone: timeZoneName(viewer)
            })}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onChange(hostTimeZone)}>
            {t('settings.bots.lookAround.zoneTheHost', '{{zone}} ({{where}})', {
              zone: timeZoneName(hostTimeZone),
              where
            })}
          </Button>
          <Button variant="ghost" size="sm" onClick={onNotNow}>
            {t('settings.bots.lookAround.zoneNotNow', 'Not now')}
          </Button>
        </div>
      ) : null}
      {picking ? (
        <Select
          value={ownZone ?? HOST_CLOCK}
          onValueChange={(value) => {
            onChange(value === HOST_CLOCK ? null : value)
            setPicking(false)
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-64 max-w-full"
            aria-label={t('settings.bots.lookAround.zone', 'Time zone')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HOST_CLOCK}>
              {t('settings.bots.lookAround.zoneFollowHost', 'Follow the clock of {{where}}', {
                where
              })}
            </SelectItem>
            {viewer !== hostTimeZone ? (
              <SelectItem value={viewer}>
                {t('settings.bots.lookAround.zoneMine', '{{zone}} (you)', {
                  zone: timeZoneName(viewer)
                })}
              </SelectItem>
            ) : null}
            <SelectSeparator />
            {allZones()
              .filter((entry) => entry !== viewer || viewer === hostTimeZone)
              .map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry.replaceAll('_', ' ')}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}

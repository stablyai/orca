// The bots found in other apps on this computer, one to pick, in New group's rows; "Another app…" last.
import React, { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItemSlot } from '@/components/ui/radio-group'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { BOT_IMPORT_APP_LABELS } from '../../../../shared/bots/bot-import'
import { botInitial } from '../../../../shared/bots/bot-avatar-fallback'
import { BotAvatarTile } from './BotAvatar'
import { BotPickFilter, BotPickRow, BotPickRows, FILTER_FROM, filterByName } from './BotPickList'
import type { ImportPick } from './ImportBotDialog'

export function importPickKey(pick: ImportPick): string {
  return `${pick.source.app}:${pick.bot.agent}`
}

function detail(pick: ImportPick): string {
  if (pick.bot.importedAs) {
    return translate('bots.import.importedAs', 'imported before as {{bot}}', {
      bot: pick.bot.importedAs.name
    })
  }
  const kind =
    pick.source.app === 'hermes'
      ? pick.bot.agent === 'default'
        ? translate('bots.import.defaultProfile', 'default profile')
        : translate('bots.import.profile', 'profile')
      : translate('bots.import.agent', 'agent')
  return translate('bots.import.rowDetail', '{{app}} {{kind}}', {
    app: BOT_IMPORT_APP_LABELS[pick.source.app],
    kind
  })
}

const TILE = 'size-7 rounded-lg text-sm'

export function ImportBotSourceList({
  picks,
  loading,
  picked,
  onPick,
  onOtherApp
}: {
  picks: readonly ImportPick[]
  loading: boolean
  picked: ImportPick | null
  onPick: (pick: ImportPick) => void
  onOtherApp: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [popped, setPopped] = useState<string | null>(null)
  const shown = filterByName(picks, query, (pick) => pick.bot.name)
  const pickedKey = picked ? importPickKey(picked) : null
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Label id="bot-import-sources">{t('bots.import.bringOver', 'Bring over')}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {loading
            ? t('bots.import.looking', 'Looking on this computer…')
            : t('bots.import.found', '{{count}} found', { count: picks.length })}
        </span>
      </div>
      {picks.length > FILTER_FROM ? <BotPickFilter value={query} onChange={setQuery} /> : null}
      <BotPickRows>
        {/* Radio keys: arrows move the pick, and the list is one Tab stop. */}
        <RadioGroup
          aria-labelledby="bot-import-sources"
          value={pickedKey ?? ''}
          onValueChange={(key) => {
            const next = picks.find((pick) => importPickKey(pick) === key)
            if (next) {
              setPopped(key)
              onPick(next)
            }
          }}
          layout="rows"
        >
          {shown.map((pick) => {
            const key = importPickKey(pick)
            return (
              <RadioGroupItemSlot key={key} value={key}>
                <BotPickRow
                  picture={
                    <BotAvatarTile
                      src={null}
                      fallback={botInitial(pick.bot.name)}
                      className={TILE}
                    />
                  }
                  name={pick.bot.name}
                  detail={detail(pick)}
                  on={key === pickedKey}
                  pop={popped === key}
                />
              </RadioGroupItemSlot>
            )
          })}
        </RadioGroup>
        <BotPickRow
          onClick={onOtherApp}
          picture={
            <span className="flex size-7 items-center justify-center rounded-lg border border-dashed border-input text-muted-foreground">
              <Plus className="size-3.5" />
            </span>
          }
          name={t('bots.import.otherApp', 'Another app…')}
          detail={t('bots.import.otherAppNote', 'Your old bot copies its files for you')}
          on={false}
          trailing={<ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        />
      </BotPickRows>
    </div>
  )
}

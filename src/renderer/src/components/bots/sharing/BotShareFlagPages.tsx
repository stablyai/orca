// The Include memory and Safety check pages: where the flags of a candidate show.
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { botShareFlagLabel, botShareFlagPage, botShareFlagWhere } from './bot-share-flags'
import { BOT_SHARE_MAX_PICKS } from '../../../../../shared/rpc-contract/bots-share-params'
import { allMemory, toggled, type BotShareContext } from './bot-share-pages'
import { SettingsInsetGroup } from '../settings-view/BotSettingsRows'
import { BotShareFlagIcon, BotShareItem, BotShareMemoryRow } from './BotShareRows'

export function MemoryList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const t = useTranslate()
  const notes = ctx.candidate.available.memory
  const picked = ctx.selection.memory ?? []
  // On only when every file that can go out does; a partial pick reads off, and turning it on picks
  // them all. A share carries at most BOT_SHARE_MAX_PICKS files, so past that All means the first ones.
  const most = allMemory(notes)
  const allPicked = most.length > 0 && most.every((topic) => picked.includes(topic))
  const full = picked.length >= BOT_SHARE_MAX_PICKS
  const total = notes.reduce((sum, note) => sum + note.lines, 0)
  return (
    <SettingsInsetGroup>
      <div className="flex min-h-10 items-center gap-2.5 py-2 pr-2.5 pl-3 text-sm">
        <span className="min-w-0 flex-1 font-medium">{t('bots.share.all', 'All')}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {notes.length > BOT_SHARE_MAX_PICKS
            ? t('bots.share.memoryLimit', 'Up to {{count}} files', { count: BOT_SHARE_MAX_PICKS })
            : total === 1
              ? t('bots.share.oneLine', '1 line')
              : t('bots.share.lines', '{{count}} lines', { count: total })}
        </span>
        <Switch
          checked={allPicked}
          aria-label={t('bots.share.all', 'All')}
          onCheckedChange={(on) => ctx.select({ memory: on ? most : [] })}
        />
      </div>
      <div className="p-1">
        {notes.map((note) => (
          <BotShareMemoryRow
            key={note.topic}
            name={note.topic}
            lines={note.lines}
            checked={picked.includes(note.topic)}
            disabled={full && !picked.includes(note.topic)}
            flags={ctx.spots
              .filter((spot) => spot.part === `memory:${note.topic}`)
              .map((spot) => ({
                kind: spot.flag.kind === 'secret' ? 'secret' : 'warning',
                text: t('bots.share.flagOnLine', '{{flag}} on line {{line}}', {
                  flag: botShareFlagLabel(spot.flag.kind),
                  line: spot.flag.line ?? 1
                })
              }))}
            onChange={(on) => ctx.select({ memory: toggled(picked, note.topic, on) })}
            onPreview={() =>
              ctx.open({
                kind: 'part',
                part: `memory:${note.topic}`,
                title: note.topic,
                detail: t('bots.share.memory', 'Memory')
              })
            }
          />
        ))}
      </div>
    </SettingsInsetGroup>
  )
}

export function SafetyCheckList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {ctx.spots.map((spot) => {
        const secret = spot.flag.kind === 'secret'
        const page = botShareFlagPage(spot)
        return (
          <BotShareItem
            key={`${spot.flag.where}:${spot.flag.line}:${spot.flag.kind}`}
            lead={<BotShareFlagIcon kind={secret ? 'secret' : 'warning'} />}
            title={botShareFlagLabel(spot.flag.kind)}
            detail={botShareFlagWhere(spot)}
            trailing={
              spot.homePath && spot.flag.line !== null ? (
                <Button
                  type="button"
                  size="xs"
                  variant={secret ? 'outline' : 'ghost'}
                  onClick={() => ctx.goToLine(spot)}
                >
                  {t('bots.share.goToLine', 'Go to line')}
                </Button>
              ) : null
            }
            onOpen={page ? () => ctx.open(page) : undefined}
          />
        )
      })}
    </>
  )
}

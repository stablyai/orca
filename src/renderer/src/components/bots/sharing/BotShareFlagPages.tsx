// The Include memory and Safety check pages: where the flags of a candidate show.
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botShareFlagLabel, botShareFlagPage, botShareFlagWhere } from './bot-share-flags'
import { toggled, type BotShareContext } from './bot-share-pages'
import { BotShareFlagIcon, BotShareFlagNote, BotShareItem } from './BotShareRows'
import { Tick } from './BotShareTick'

export function MemoryList({ ctx }: { ctx: BotShareContext }): React.JSX.Element {
  const t = useTranslate()
  const picked = ctx.selection.memory ?? []
  return (
    <>
      {ctx.candidate.available.memory.map((note) => {
        const spots = ctx.spots.filter((spot) => spot.part === `memory:${note.topic}`)
        return (
          <BotShareItem
            key={note.topic}
            lead={
              <Tick
                checked={picked.includes(note.topic)}
                label={note.topic}
                onChange={(on) => ctx.select({ memory: toggled(picked, note.topic, on) })}
              />
            }
            title={note.topic}
            detail={t('bots.share.lines', '{{count}} lines', { count: note.lines })}
            note={spots.map((spot) => (
              <BotShareFlagNote
                key={`${spot.flag.kind}:${spot.flag.line}`}
                kind={spot.flag.kind === 'secret' ? 'secret' : 'warning'}
              >
                {t('bots.share.flagOnLine', '{{flag}} on line {{line}}', {
                  flag: botShareFlagLabel(spot.flag.kind),
                  line: spot.flag.line ?? 1
                })}
              </BotShareFlagNote>
            ))}
            onOpen={() =>
              ctx.open({
                kind: 'part',
                part: `memory:${note.topic}`,
                title: note.topic,
                detail: t('bots.share.memory', 'Memory')
              })
            }
          />
        )
      })}
    </>
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

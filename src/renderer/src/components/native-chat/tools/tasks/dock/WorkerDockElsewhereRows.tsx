import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { WorkerDockElsewhereEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { WorkerDockGlyph } from './WorkerDockGlyph'

/** Up to this many chats show as rows; with more, three rows and "+N more chats". */
const ALL_ROWS = 4
const CAPPED_ROWS = 3

/** The Other chats rows to draw and how many chats they leave out. */
export function workerDockElsewhereShown(entries: readonly WorkerDockElsewhereEntry[]): {
  shown: readonly WorkerDockElsewhereEntry[]
  more: number
} {
  return entries.length <= ALL_ROWS
    ? { shown: entries, more: 0 }
    : { shown: entries.slice(0, CAPPED_ROWS), more: entries.length - CAPPED_ROWS }
}

/** A row's id in the card's keyboard order and focus tracking, apart from any worker's. */
export function workerDockElsewhereRowId(entry: { source: string }): string {
  return `elsewhere:${entry.source}`
}

export function workerDockElsewhereTitle(t: Translate, entry: { title?: string }): string {
  return entry.title?.trim() || t('components.native-chat.workerDock.untitledChat', 'Untitled chat')
}

/** How many run in other chats, all together. */
export function workerDockElsewhereRunning(entries: readonly WorkerDockElsewhereEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.running, 0)
}

const NO_ELSEWHERE: readonly WorkerDockElsewhereEntry[] = []

/** The Other chats rows the card draws: their ids in keyboard order, how many run, and how many list
 *  lines they take (rows, the label, and "+N more"). */
export function useWorkerDockElsewhere(
  entries: readonly WorkerDockElsewhereEntry[] = NO_ELSEWHERE
) {
  const view = useMemo(() => workerDockElsewhereShown(entries), [entries])
  const ids = useMemo(
    () => view.shown.map((entry) => ({ id: workerDockElsewhereRowId(entry) })),
    [view]
  )
  return {
    entries,
    ids,
    running: workerDockElsewhereRunning(entries),
    lines: ids.length ? ids.length + 1 + (view.more ? 1 : 0) : 0
  }
}

/** The chip with other chats' work: after this chat's own ("2 running · +25"), or on its own ("25
 *  elsewhere") when this chat lists nothing. `spoken` is the same in full words. */
export function workerDockElsewhereChip<
  Chip extends { label: string; spoken: string; titled: boolean }
>(t: Translate, own: Chip, ownShown: boolean, running: number): Chip & { elsewhereSpoken: string } {
  if (!running) {
    return { ...own, elsewhereSpoken: '' }
  }
  if (ownShown) {
    const elsewhereSpoken = t(
      'components.native-chat.workerDock.elsewhereMoreSpoken',
      '{{count}} more running in other chats',
      { count: running, defaultValue_one: '{{count}} more running in other chats' }
    )
    return {
      ...own,
      label: `${own.label} · +${running}`,
      spoken: `${own.spoken}, ${elsewhereSpoken}`,
      elsewhereSpoken
    }
  }
  const elsewhereSpoken = t(
    'components.native-chat.workerDock.elsewhereSpoken',
    '{{count}} workers running in other chats',
    { count: running, defaultValue_one: '{{count}} worker running in other chats' }
  )
  return {
    ...own,
    label: t('components.native-chat.workerDock.elsewhereChip', '{{count}} elsewhere', {
      count: running,
      defaultValue_one: '{{count}} elsewhere'
    }),
    spoken: elsewhereSpoken,
    titled: false,
    elsewhereSpoken
  }
}

/** Work running in chats this chat handed work to: one read-only row per chat, which opens that
 *  chat. Stop, Clear and approvals stay in the chat that started the workers. */
export function WorkerDockElsewhereRows({
  entries,
  onOpen
}: {
  entries: readonly WorkerDockElsewhereEntry[]
  onOpen: (entry: WorkerDockElsewhereEntry, opener: HTMLElement) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!entries.length) {
    return null
  }
  const { shown, more } = workerDockElsewhereShown(entries)
  return (
    <div
      data-worker-dock-elsewhere=""
      role="group"
      aria-label={t('components.native-chat.workerDock.otherChats', 'Other chats')}
    >
      <div
        aria-hidden="true"
        className="flex h-6 items-end pb-0.5 pl-7 text-2xs text-muted-foreground"
      >
        {t('components.native-chat.workerDock.otherChats', 'Other chats')}
      </div>
      {shown.map((entry) => {
        const id = workerDockElsewhereRowId(entry)
        const title = workerDockElsewhereTitle(t, entry)
        return (
          <div
            key={id}
            data-worker-dock-row={id}
            className="group/worker relative flex min-w-0 rounded-md pr-2 hover:bg-accent has-focus-visible:bg-accent"
          >
            <button
              type="button"
              data-worker-dock-open={id}
              aria-label={t(
                'components.native-chat.workerDock.elsewhereRow',
                '{{chat}}, {{count}} running, opens chat',
                {
                  chat: title,
                  count: entry.running,
                  defaultValue_one: '{{chat}}, {{count}} running, opens chat'
                }
              )}
              title={title}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2 text-left text-sm whitespace-nowrap after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
              onClick={(event) => onOpen(entry, event.currentTarget)}
            >
              <span className="flex h-5 w-3 shrink-0 items-center justify-center">
                <WorkerDockGlyph glyph="running" />
              </span>
              <span
                data-worker-dock-elsewhere-title=""
                className="min-w-0 flex-1 truncate text-muted-foreground"
              >
                {title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {entry.running}
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            </button>
          </div>
        )
      })}
      {more ? (
        <p className="flex h-6 items-center pl-7 text-xs text-muted-foreground">
          {t('components.native-chat.workerDock.moreChats', '+{{count}} more chats', {
            count: more,
            defaultValue_one: '+{{count}} more chat'
          })}
        </p>
      ) : null}
    </div>
  )
}

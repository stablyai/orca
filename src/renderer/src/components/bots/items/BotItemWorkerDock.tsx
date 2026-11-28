import { useCallback, useMemo, useState } from 'react'
import { ChevronUp, CircleStop } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemWorkerRow } from '../../../../../shared/bots/bot-item-link-rows'
import {
  botItemLinksOnePerChain,
  type BotItemLinkView,
  type BotItemWorkerState
} from '../../../../../shared/bots/bot-items'
import { workerDockWorkerCount } from '../../native-chat/tools/tasks/dock/worker-dock-labels'
import { WorkerDockGlyph } from '../../native-chat/tools/tasks/dock/WorkerDockGlyph'
import { botChatTreeWorkerOpen, WorkerStateIcon } from '../BotChatTreeWorkerRow'

type WorkerLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

function statusLabel(t: Translate, state: BotItemWorkerState): string {
  switch (state) {
    case 'working':
      return t('components.native-chat.workerDock.running', 'Running')
    case 'completed':
      return t('bots.activity.completed', 'Completed')
    case 'failed':
      return t('components.native-chat.workerDock.failed', 'Failed')
    case 'stopped':
      return t('components.native-chat.subagents.stateHeading.stopped', 'Stopped')
    case 'unknown':
      return t('components.native-chat.workerDock.unavailableState', 'Status unavailable')
    case 'missing':
      return t('components.native-chat.workerDock.resultUnavailable', 'Worker result unavailable')
  }
}

function ItemWorkerIcon({
  state,
  mapped
}: {
  state: BotItemWorkerState
  mapped: ReturnType<typeof botItemWorkerRow>['state']
}): React.JSX.Element {
  return state === 'stopped' ? (
    <CircleStop className="size-3 text-muted-foreground" />
  ) : (
    <WorkerStateIcon state={state === 'missing' ? 'unreachable' : mapped} />
  )
}

function WorkerRows({ bot, links }: { bot: Bot; links: readonly WorkerLink[] }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {links.map((link) => {
        const worker = botItemWorkerRow(link)
        const onOpen = link.state === 'missing' ? undefined : botChatTreeWorkerOpen(bot, worker)
        return (
          <DropdownMenuItem
            key={worker.key}
            disabled={!onOpen}
            focusableWhenDisabled
            onSelect={onOpen}
            textValue={worker.title}
            className="items-start"
          >
            <span aria-hidden="true" className="flex h-4 w-3 shrink-0 items-center justify-center">
              <ItemWorkerIcon state={link.state} mapped={worker.state} />
            </span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{worker.title}</span>
            <span className="max-w-[45%] shrink-0 text-right text-2xs text-muted-foreground">
              {statusLabel(t, link.state)}
            </span>
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

export function BotItemWorkerDock({
  bot,
  links
}: {
  bot: Bot
  links: readonly BotItemLinkView[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const trigger = useCallback((node: HTMLButtonElement | null) => {
    setPane(node?.closest<HTMLElement>('[data-bot-item-focus-home]') ?? null)
  }, [])
  const workers = useMemo(
    () => botItemLinksOnePerChain(links).filter((link) => link.kind === 'dispatch'),
    [links]
  )
  if (workers.length === 0) {
    return null
  }

  const running = workers.filter((link) => link.state === 'working').length
  const lead =
    workers.find((link) => link.state === 'working') ??
    workers.find((link) => link.state !== 'completed') ??
    workers[0]
  const leadWorker = botItemWorkerRow(lead)
  const count = workerDockWorkerCount(t, workers.length)
  const summary = running
    ? t('bots.chats.runningCount', '{{count}} running', { count: running })
    : `${leadWorker.title}, ${statusLabel(t, lead.state)}`

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="pill"
          aria-label={`${count}, ${summary}`}
          className="mx-3 self-start"
        >
          <span aria-hidden="true">
            {running ? (
              <WorkerDockGlyph glyph="running" chip />
            ) : (
              <ItemWorkerIcon state={lead.state} mapped={leadWorker.state} />
            )}
          </span>
          {count}
          <ChevronUp aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        aria-label={count}
        collisionBoundary={pane ?? undefined}
        collisionPadding={8}
        className="w-60 min-w-0 max-w-(--radix-dropdown-menu-content-available-width) max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))]"
      >
        <WorkerRows bot={bot} links={workers} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

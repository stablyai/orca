import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { foldBotStatus } from '../../../../shared/bots/bot-row-status'
import {
  botPreviewCapacity,
  botPreviewFacts,
  botPreviewSignal,
  collapsedBotPreview
} from '../../../../shared/bots/bot-collapsed-preview'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotAvatar } from './BotAvatar'
import { useBotHomeWorkers } from './use-bot-sidebar-arrangement'

export function useBotPreviewFacts(rows: { bot: Bot; home: FolderWorkspace }[]) {
  const homes = useMemo(() => rows.map(({ home }) => home), [rows])
  const homeWorkers = useBotHomeWorkers(homes)
  return rows.map(({ bot, home }, index) => ({
    bot,
    ...botPreviewFacts({
      own: homeWorkers[index]!.own,
      workspaces: homeWorkers[index]!.workerStatuses,
      homeUnread: home.isUnread,
      paused: bot.paused
    })
  }))
}

type Facts = ReturnType<typeof useBotPreviewFacts>[number]
function label(fact: Facts): string {
  const status = foldBotStatus(fact.status, fact.paused)
  return `${fact.bot.name} · ${botPreviewSignal(fact) === 'attention' ? 'Needs you' : status === 'working' ? 'Working' : fact.paused ? 'Paused' : 'Idle'}${fact.unread ? ' · Unread' : ''}`
}

// Each face is its own target, spread apart and still under the pointer; the header around them still folds.
const FACE_CLASS_NAME =
  'pointer-events-auto relative shrink-0 rounded-full ring-2 ring-sidebar outline-none hover:ring-sidebar-ring focus-visible:ring-sidebar-ring'

export function BotCollapsedPreview({
  facts,
  onOpenBot,
  onExpand
}: {
  facts: Facts[]
  onOpenBot: (bot: Bot) => void
  onExpand: () => void
}) {
  const t = useTranslate()
  const ref = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) {
      return
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const preview = collapsedBotPreview(facts, botPreviewCapacity(width, facts.length))
  return (
    <span
      ref={ref}
      className="pointer-events-none flex min-w-0 flex-1 items-center justify-center overflow-hidden py-1"
      data-bot-preview=""
    >
      <span className="isolate flex items-center space-x-1">
        {preview.shown.map((fact, index) => (
          <Tooltip key={fact.bot.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label(fact)}
                className={FACE_CLASS_NAME}
                style={{ zIndex: 10 - index }}
                onClick={() => onOpenBot(fact.bot)}
              >
                <BotAvatar bot={fact.bot} className="size-5 rounded-full text-2xs" />
                <PreviewPip signal={botPreviewSignal(fact)} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label(fact)}</TooltipContent>
          </Tooltip>
        ))}
        {preview.hidden.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('bots.section.showMore', 'Show {{count}} more bots', {
                  count: preview.hidden.length,
                  defaultValue_one: 'Show {{count}} more bot'
                })}
                className={cn(
                  FACE_CLASS_NAME,
                  'flex size-5 items-center justify-center bg-muted text-3xs font-medium text-muted-foreground'
                )}
                onClick={onExpand}
              >
                +{preview.hidden.length}
                <PreviewPip signal={preview.hiddenSignal} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{preview.hidden.map(label).join(', ')}</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </span>
  )
}

// Working spins as the sidebar's agents do; unread is a dot.
// Needs-you has no badge: those bots lead the faces and their tooltip says so.
function PreviewPip({ signal }: { signal: ReturnType<typeof botPreviewSignal> }) {
  if (signal === 'working') {
    return (
      <span className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-sidebar">
        <AgentWorkingSpinner className="size-2.5" />
      </span>
    )
  }
  return signal === 'unread' ? (
    <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-foreground ring-1 ring-sidebar" />
  ) : null
}

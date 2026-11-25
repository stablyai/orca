import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { workerDockScrollFade } from '@/components/native-chat/tools/tasks/dock/worker-dock-scroll-anchor'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliProductName } from './agent-cli-product-name'
import { copyAgentCliUpdateCommand } from '../status-bar/updates/AgentCliUpdateList'
import type { AgentCliUpdateAgent } from '../../../../shared/agent-launch/installation/agent-cli-update'

const COPIED_MS = 1200

/** One CLI in the toast's list. */
export type AgentCliUpdateToastItem = {
  key: string
  /** Heading shown before the first row of a host; null when no host heading is needed. */
  hostLabel: string | null
  agent: AgentCliUpdateAgent
  from: string
  to: string
  status: 'idle' | 'queued' | 'running' | 'failed' | 'done'
  /** Set for a CLI Orca can't update: the command the user runs in a terminal. */
  manualCommand: string | null
  onOpenFailure?: () => void
}

/** Opens to its content's height; closed content is inert so focus can't land in it. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

function Heading({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground">{children}</div>
}

function CopyButton({ command }: { command: string }): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
      }
    },
    []
  )
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="-my-1"
      onClick={() =>
        void copyAgentCliUpdateCommand(command, t, { announce: false }).then((ok) => {
          if (!ok) {
            return
          }
          setCopied(true)
          if (timer.current !== null) {
            window.clearTimeout(timer.current)
          }
          timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
        })
      }
    >
      {/* Polite, so screen readers hear Copied as the toast would have said it. */}
      <span aria-live="polite">
        {copied ? t('agentCliUpdate.copied', 'Copied') : t('agentCliUpdate.copyCommand', 'Copy')}
      </span>
    </Button>
  )
}

function Status({ item }: { item: AgentCliUpdateToastItem }): React.JSX.Element | null {
  const t = useTranslate()
  if (item.manualCommand) {
    return <CopyButton command={item.manualCommand} />
  }
  switch (item.status) {
    case 'queued':
      return (
        <span className="text-xs text-muted-foreground">
          {t('agentCliUpdate.queued', 'Queued')}
        </span>
      )
    case 'running':
      return (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
      )
    case 'done':
      return <Check className="size-3.5 text-status-success" />
    case 'failed':
      return item.onOpenFailure ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost-destructive"
              size="icon-xs"
              // The glyph, not the hit area, ends on the column edge.
              className="-mr-[5px]"
              aria-label={t('agentCliUpdate.failedChipLabel', 'Update failed: view error')}
              onClick={item.onOpenFailure}
            >
              <CircleAlert className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('agentCliUpdate.failedChipTooltip', 'Update failed. Click to see details.')}
          </TooltipContent>
        </Tooltip>
      ) : (
        <CircleAlert className="size-3.5 text-destructive" />
      )
    case 'idle':
      return null
  }
}

function Row({ item }: { item: AgentCliUpdateToastItem }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-8 items-center gap-2.5 px-2">
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {agentCliProductName(item.agent, t, 'short')}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {t('agentCliUpdate.versions', '{{installed}} → {{latest}}', {
          installed: item.from,
          latest: item.to
        })}
      </span>
      {/* One fixed trailing column in every state, so versions end on the same edge. */}
      <span className="flex w-14 shrink-0 justify-end">
        <Status item={item} />
      </span>
    </div>
  )
}

function Rows({ items }: { items: readonly AgentCliUpdateToastItem[] }): React.JSX.Element {
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {item.hostLabel && item.hostLabel !== items[index - 1]?.hostLabel ? (
            <Heading>{item.hostLabel}</Heading>
          ) : null}
          <Row item={item} />
        </Fragment>
      ))}
    </>
  )
}

/** Updatable CLIs first, then the ones the user updates by hand; scrolls inside the toast. */
export function AgentCliUpdateToastList({
  open,
  items
}: {
  open: boolean
  items: readonly AgentCliUpdateToastItem[]
}): React.JSX.Element {
  const t = useTranslate()
  const auto = items.filter((item) => !item.manualCommand)
  const manual = items.filter((item) => item.manualCommand)
  const [fade, setFade] = useState<string | undefined>(undefined)
  const viewport = useRef<HTMLDivElement>(null)
  const refade = (): void =>
    setFade(viewport.current ? workerDockScrollFade(viewport.current) : undefined)
  useLayoutEffect(() => {
    setFade(viewport.current ? workerDockScrollFade(viewport.current) : undefined)
  }, [open, items.length])
  return (
    <Reveal open={open}>
      <div className="mx-2 mt-2 border-t border-border" />
      <div
        ref={viewport}
        className="max-h-[300px] scroll-py-1 overflow-y-auto pt-1 scrollbar-sleek"
        // Fades the edge rows continue past, so a clipped row or heading reads as more below.
        style={{ maskImage: fade }}
        onScroll={refade}
      >
        <Rows items={auto} />
        {manual.length > 0 ? (
          <>
            <Heading>{t('agentCliUpdate.manualSection', 'Manual')}</Heading>
            <Rows items={manual} />
          </>
        ) : null}
      </div>
    </Reveal>
  )
}

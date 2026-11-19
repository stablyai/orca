// An answered permission prompt as one quiet transcript line, drawn like the chat's other quiet rows:
// shield, sentence with the tool as a chip, time on the right; the command and reason open under it.
import { useState } from 'react'
import { Trans } from 'react-i18next'
import {
  ChevronRight,
  ShieldCheck,
  ShieldMinus,
  ShieldQuestion,
  ShieldX,
  SquareTerminal
} from 'lucide-react'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import type {
  NativeChatApprovalRecordLine,
  NativeChatApprovalRecordTone
} from './native-chat-approval-record'

const TONE_ICON: Record<NativeChatApprovalRecordTone, typeof ShieldCheck> = {
  allowed: ShieldCheck,
  denied: ShieldX,
  open: ShieldQuestion,
  closed: ShieldMinus
}

function ToolChip({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-chat-foreground/5 px-1.5 align-middle text-xs leading-5 text-chat-foreground">
      <SquareTerminal className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

const OPEN_WORKER_CLASS =
  'rounded-sm font-medium text-chat-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** A worker's task, opening that worker. */
function TaskButton({
  onOpen,
  children
}: {
  onOpen: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" onClick={onOpen} className={OPEN_WORKER_CLASS}>
      {children}
    </button>
  )
}

export function NativeChatApprovalRecord({
  line,
  onOpenWorker
}: {
  line: NativeChatApprovalRecordLine
  /** A worker's record: its task, and an Open worker link where the line has one, open the worker. */
  onOpenWorker?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const Icon = TONE_ICON[line.tone]
  const opens = Boolean(line.detail || line.reason)
  return (
    <div data-native-chat-approval-record={line.tone} className="flex flex-col gap-0.5">
      <div className="@container flex min-h-6 items-start gap-1.5 font-sans text-sm leading-relaxed text-chat-foreground-faint">
        <Icon className="mt-[5px] size-3.5 shrink-0" aria-hidden />
        <span className="line-clamp-2 min-w-0 flex-1">
          <Trans
            i18n={i18n}
            defaults={line.sentence}
            values={line.values}
            components={{
              tool: <ToolChip />,
              task: onOpenWorker ? <TaskButton onOpen={onOpenWorker} /> : <span />
            }}
          />
          {line.opensWorker && onOpenWorker ? (
            <>
              <span aria-hidden> · </span>
              <button type="button" onClick={onOpenWorker} className={OPEN_WORKER_CLASS}>
                {t('components.native-chat.approval.openWorker', 'Open worker')}
              </button>
            </>
          ) : null}
        </span>
        {opens ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={
              open
                ? t('components.native-chat.approval.record.showLess', 'Show less')
                : t('components.native-chat.approval.record.showMore', 'Show more')
            }
            onClick={() => setOpen(!open)}
            className="mt-[3px] rounded-sm hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
        ) : null}
        <span className="mt-[3px] shrink-0 text-xs @max-xs:hidden">
          <NativeChatMessageTimestamp timestamp={line.at} />
        </span>
      </div>
      {open ? (
        <div className="flex flex-col gap-0.5 pl-5 text-xs text-chat-foreground-faint">
          {line.reason ? (
            <p className="whitespace-pre-wrap break-words">
              <span className="font-medium">{line.reason.label}: </span>
              {line.reason.text}
            </p>
          ) : null}
          {line.detail ? (
            <p
              data-native-chat-code-content
              className="scrollbar-sleek max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-chat-code"
            >
              {line.detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

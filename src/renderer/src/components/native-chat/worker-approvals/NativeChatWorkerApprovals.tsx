import { useEffect, useMemo, useState, useRef } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useWorkerDockStructuralValue } from '../tools/tasks/dock/NativeChatWorkerDockFrame'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import { NativeChatApprovalRecord } from '../prompts/NativeChatApprovalRecord'
import { workerApprovalTimeLeft } from '../../../../../shared/orchestration/approvals/worker-approval-time-left'
import {
  isWorkerApprovalDecision,
  workerApprovalCard,
  workerApprovalRecordLine
} from './worker-approval-card-model'
import {
  useNativeChatWorkerApprovalReceipts,
  type NativeChatWorkerApproval
} from './native-chat-worker-approval-feed'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatTimedRow } from '../conversation/slots/native-chat-timed-rows'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { WorkerApprovalDecision } from '../../../../../shared/orchestration/approvals/worker-approval-payload'

// The person's own Deny: the worker gets this, word for word where its agent takes a message.
const OWNER_DENY_REASON = 'Denied by the owner.'

/** A worker's answered or lapsed prompt, in the transcript where the worker first asked. */
export function NativeChatWorkerApprovalReceipt({
  entry,
  target
}: {
  entry: NativeChatWorkerApproval
  target: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const { approval } = entry
  return (
    <div data-native-chat-worker-approval-receipt={approval.approvalId}>
      <NativeChatApprovalRecord
        line={workerApprovalRecordLine(approval, entry.worker.label, entry.at, t)}
        onOpenWorker={() => void openOrchestrationCrewAgent(entry.worker, target)}
      />
    </div>
  )
}

/** Workers' prompts pinned above the composer, oldest first: open ones as cards, and ones only the
 *  worker's terminal can answer as their receipt. A card here never takes focus or cancels the chat's turn. */
export function NativeChatWorkerApprovalStack({
  approvals: liveApprovals,
  target,
  isVisible = true
}: {
  approvals: readonly NativeChatWorkerApproval[]
  target: RuntimeClientTarget
  /** A hidden pane's countdown stands still; it shows the time again once visible. */
  isVisible?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const seenPrompts = useRef(new Set<string>())
  const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    const arrived = liveApprovals.filter(
      (entry) =>
        entry.approval.state === 'open' && !seenPrompts.current.has(entry.approval.approvalId)
    )
    for (const entry of arrived) {
      seenPrompts.current.add(entry.approval.approvalId)
    }
    if (arrived.length) {
      setAnnouncement({
        id: arrived.at(-1)!.approval.approvalId,
        text: t(
          'components.native-chat.workerDock.newQuestions',
          '{{count}} new worker questions waiting on you',
          {
            count: arrived.length,
            defaultValue_one: '{{count}} new worker question waiting on you'
          }
        )
      })
    }
  }, [liveApprovals, t])
  const approvals = useWorkerDockStructuralValue(liveApprovals)
  const root = useRef<HTMLDivElement>(null)
  const [short, setShort] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const hasApprovals = approvals.length > 0
  useEffect(() => {
    const pane = root.current?.closest('[data-native-chat-root]')
    if (!pane) {
      return
    }
    const observer = new ResizeObserver(() => setShort(pane.getBoundingClientRect().height < 520))
    observer.observe(pane)
    return () => observer.disconnect()
  }, [hasApprovals])
  const open = useMemo(
    () =>
      approvals
        .filter(({ approval }) => approval.state === 'open')
        .toReversed()
        .sort((a, b) => Date.parse(b.askedAt ?? b.at) - Date.parse(a.askedAt ?? a.at)),
    [approvals]
  )
  // Each prompt being answered here, and with which decision: the card waits on the host's outcome.
  const [submitting, setSubmitting] = useState<ReadonlyMap<string, WorkerApprovalDecision>>(
    new Map()
  )
  const now = useSecondClock(isVisible && open.some(({ approval }) => approval.expiresAt))
  const answer = (entry: NativeChatWorkerApproval, decision: WorkerApprovalDecision): void => {
    const { approvalId, worker } = entry.approval
    setSubmitting((current) => new Map(current).set(approvalId, decision))
    const name = entry.worker.label
    callRuntimeRpc(target, 'orchestration.approvalAnswer', {
      dispatch: worker.dispatchId,
      prompt: approvalId,
      decision,
      ...(decision === 'deny' ? { reason: OWNER_DENY_REASON } : {})
    })
      // A landed answer needs no toast: the host's list turns the card into its receipt.
      .catch((error: unknown) => {
        // Not applied: the host's list decides. A prompt that closed meanwhile (its worker ended,
        // or it was answered elsewhere) turns into its receipt from that; one still open stays answerable.
        const code = error instanceof RuntimeRpcCallError ? error.code : null
        if (code === 'dispatch_inactive' || code === 'approval_not_open') {
          toast.info(
            code === 'dispatch_inactive'
              ? t(
                  'components.native-chat.approval.answerWorkerEnded',
                  '{{name}} has ended, so this prompt is closed',
                  { name }
                )
              : t(
                  'components.native-chat.approval.answerNotApplied',
                  '{{name}}: the answer did not reach this prompt',
                  { name }
                )
          )
          return
        }
        toast.error(
          t('components.native-chat.approval.answerFailed', '{{name}}: {{detail}}', {
            name,
            detail: error instanceof Error ? error.message : String(error)
          })
        )
      })
      .finally(() =>
        setSubmitting((current) => {
          const next = new Map(current)
          next.delete(approvalId)
          return next
        })
      )
  }
  if (approvals.length === 0) {
    return (
      <span key={announcement?.id} className="sr-only" role="status" aria-live="polite">
        {announcement?.text}
      </span>
    )
  }
  const compact = short
  const selectedEntry = selected
    ? open.find((entry) => entry.approval.approvalId === selected)
    : undefined
  const shown = compact
    ? undefined
    : (selectedEntry ?? open.find((entry) => !folded.has(entry.approval.approvalId)))
  const queued = open.filter((entry) => entry !== shown)
  const card = (entry: NativeChatWorkerApproval) => {
    const { approval } = entry
    const left = workerApprovalTimeLeft(approval.expiresAt, now)
    return (
      <NativeChatApprovalCard
        key={approval.approvalId}
        approval={workerApprovalCard(approval, t)}
        onChoose={(decision) => {
          if (isWorkerApprovalDecision(decision)) {
            answer(entry, decision)
          }
        }}
        onCollapse={() => {
          setFolded((current) => new Set(current).add(approval.approvalId))
          setSelected(null)
        }}
        isSubmitting={submitting.has(approval.approvalId)}
        submittingOption={submitting.get(approval.approvalId)}
        worker={{
          name: entry.worker.label,
          onOpen: () => void openOrchestrationCrewAgent(entry.worker, target)
        }}
        countdown={
          left
            ? t(
                'components.native-chat.approval.countdown',
                'Claude denies it on its own in {{time}} if nobody answers.',
                { time: left }
              )
            : undefined
        }
        placement="dock"
      />
    )
  }
  return (
    <div
      ref={root}
      className="scrollbar-sleek min-h-0 max-h-[max(44px,min(40cqh,calc(100cqh-180px)))] overflow-y-auto overscroll-contain"
      data-native-chat-worker-approvals=""
    >
      <span key={announcement?.id} className="sr-only" role="status" aria-live="polite">
        {announcement?.text}
      </span>
      {shown ? (
        <div data-native-chat-worker-approval={shown.approval.approvalId}>
          <div className="flex min-h-8 items-center gap-2 px-4 pt-1 text-xs text-chat-warning">
            <CircleHelp className="size-4" />
            <span>
              {t(
                'components.native-chat.workerDock.waitingOnYouName',
                '{{name}} · Waiting on you',
                { name: shown.worker.label }
              )}
            </span>
          </div>
          {card(shown)}
        </div>
      ) : null}
      {queued.length ? (
        <>
          <p className="flex h-6 items-center px-4 text-2xs text-muted-foreground">
            {shown
              ? t(
                  'components.native-chat.workerDock.moreQuestions',
                  '{{count}} more waiting on you',
                  { count: queued.length }
                )
              : t('components.native-chat.workerDock.questions', '{{count}} waiting on you', {
                  count: queued.length
                })}
          </p>
          <div
            role="region"
            aria-label={t(
              'components.native-chat.workerDock.queuedQuestions',
              'Queued worker questions'
            )}
            className="min-h-0"
          >
            {queued.map((entry) => (
              <div
                key={entry.approval.approvalId}
                data-native-chat-worker-question-summary={entry.approval.approvalId}
                className="flex h-11 min-w-0 shrink-0 scroll-mt-11 items-center gap-2 px-4 text-xs"
              >
                <CircleHelp aria-hidden="true" className="size-4 shrink-0 text-chat-warning" />
                <span className="min-w-0 flex-1 truncate">
                  {entry.worker.label} · {entry.approval.summary.title}
                </span>
                <Button
                  variant="ghost-inset"
                  size="sm"
                  className="h-11 min-w-11 shrink-0"
                  aria-label={t(
                    'components.native-chat.workerDock.showQuestion',
                    'Show {{name}} question',
                    { name: entry.worker.label }
                  )}
                  onClick={() => {
                    setSelected(entry.approval.approvalId)
                    setFolded((current) => {
                      const next = new Set(current)
                      next.delete(entry.approval.approvalId)
                      return next
                    })
                  }}
                >
                  {t('components.native-chat.workerDock.show', 'Show')}
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {compact && selectedEntry ? (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value) {
              setSelected(null)
            }
          }}
        >
          <DialogContent surface="security" scrollable>
            <DialogHeader className="sr-only">
              <DialogTitle>{selectedEntry.approval.summary.title}</DialogTitle>
              <DialogDescription>{selectedEntry.worker.label}</DialogDescription>
            </DialogHeader>
            {card(selectedEntry)}
          </DialogContent>
        </Dialog>
      ) : null}
      {approvals
        .filter((entry) => entry.approval.state !== 'open')
        .map((entry) => (
          <NativeChatWorkerApprovalReceipt
            key={entry.approval.approvalId}
            entry={entry}
            target={target}
          />
        ))}
    </div>
  )
}

/** A per-second clock, only while some countdown is shown. */
function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    // Stops while the window is hidden; a visible card shows the time again at once.
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1_000 })
  }, [active])
  return now
}

/** The chat's address its workers report to, when it can coordinate: an Orca session on its host. */
export function nativeChatWorkerApprovalParty(pane: { sessionId: string }): string | null {
  return isOrcaSessionId(pane.sessionId) ? formatOrcaSessionAddress(pane.sessionId) : null
}

/** A coordinator chat's closed worker prompts, each in its transcript at the time the worker
 *  asked. Holds them itself, so only the transcript redraws, and only when a receipt changes. */
export function NativeChatWorkerApprovalTimeline({
  party,
  target,
  children
}: {
  party: string | null
  target: RuntimeClientTarget
  children: (timedRows: readonly NativeChatTimedRow[]) => React.ReactNode
}): React.ReactNode {
  const receipts = useNativeChatWorkerApprovalReceipts(target, party)
  const timedRows = useMemo(
    () =>
      receipts.map((entry) => ({
        key: `worker-approval:${entry.approval.approvalId}`,
        at: Date.parse(entry.askedAt ?? entry.at),
        node: <NativeChatWorkerApprovalReceipt entry={entry} target={target} />
      })),
    [receipts, target]
  )
  return children(timedRows)
}

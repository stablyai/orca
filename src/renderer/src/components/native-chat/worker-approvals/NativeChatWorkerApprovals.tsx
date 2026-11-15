import { useEffect, useMemo, useState, useRef } from 'react'
import { CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  useWorkerDockRosterState,
  useWorkerDockStructuralValue
} from '../tools/tasks/dock/NativeChatWorkerDockFrame'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { openOrchestrationCrewAgent } from '@/lib/agent-session/open/open-agent-message-sender'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import { NativeChatResolutionReceipt } from '../prompts/NativeChatResolutionReceipt'
import {
  isWorkerApprovalDecision,
  workerApprovalCard,
  workerApprovalReceiptBody,
  workerApprovalReceiptReason,
  workerApprovalReceiptText,
  workerApprovalTimeLeft
} from './worker-approval-card-model'
import {
  useNativeChatPinnedWorkerApprovals,
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
  entry
}: {
  entry: NativeChatWorkerApproval
}): React.JSX.Element {
  const t = useTranslate()
  const { approval } = entry
  return (
    <div
      className="px-3 pb-2 sm:px-4"
      data-native-chat-worker-approval-receipt={approval.approvalId}
    >
      <NativeChatResolutionReceipt
        body={workerApprovalReceiptBody(approval, entry.at, t)}
        outcome={{
          worker: entry.worker.label,
          text: workerApprovalReceiptText(approval, t),
          ...workerApprovalReceiptReason(approval, t)
        }}
      />
    </div>
  )
}

/** Workers' prompts pinned above the composer, oldest first: open ones as cards, and ones just
 *  closed as their receipt. A card here never takes focus or cancels the chat's turn. */
export function NativeChatWorkerApprovalStack({
  approvals,
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
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const arrived = approvals.filter(
      (entry) =>
        entry.approval.state === 'open' && !seenPrompts.current.has(entry.approval.approvalId)
    )
    for (const entry of arrived) {
      seenPrompts.current.add(entry.approval.approvalId)
    }
    if (arrived.length) {
      setAnnouncement(
        `${arrived.length} new worker ${arrived.length === 1 ? 'question' : 'questions'} waiting on you`
      )
    }
  }, [approvals])
  approvals = useWorkerDockStructuralValue(approvals)
  const roster = useWorkerDockRosterState()
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
  const open = approvals.filter(({ approval }) => approval.state === 'open')
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
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    )
  }
  const compact = roster.expanded || short
  const shown = compact
    ? undefined
    : (open.find((entry) => entry.approval.approvalId === selected) ??
      open.find((entry) => !folded.has(entry.approval.approvalId)))
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
    <div ref={root} className="min-h-0 border-t border-border" data-native-chat-worker-approvals="">
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {shown ? (
        <div data-native-chat-worker-approval={shown.approval.approvalId}>
          <div className="flex min-h-8 items-center gap-2 px-4 pt-1 text-xs text-muted-foreground">
            <CircleHelp className="size-4" />
            <span>{shown.worker.label} · Waiting on you</span>
          </div>
          {card(shown)}
        </div>
      ) : null}
      {queued.length ? (
        <>
          <p className="flex h-6 items-center px-4 text-xs text-muted-foreground">
            {queued.length} {shown ? 'more ' : ''}waiting on you
          </p>
          <div
            role="region"
            aria-label="Queued worker questions"
            className="scrollbar-sleek max-h-22 overflow-y-auto overscroll-contain"
            style={{ scrollSnapType: 'y mandatory' }}
          >
            {queued.map((entry) => (
              <div
                key={entry.approval.approvalId}
                data-native-chat-worker-question-summary={entry.approval.approvalId}
                className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-4 text-xs"
                style={{ scrollSnapAlign: 'start' }}
              >
                <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {entry.worker.label} · {entry.approval.summary.title}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 min-w-11 shrink-0"
                  aria-label={`Show ${entry.worker.label} question`}
                  onFocus={(event) =>
                    event.currentTarget
                      .closest('[data-native-chat-worker-question-summary]')
                      ?.scrollIntoView({ block: 'nearest' })
                  }
                  onClick={() => {
                    if (compact) {
                      void openOrchestrationCrewAgent(entry.worker, target)
                    } else {
                      setSelected(entry.approval.approvalId)
                      setFolded((current) => {
                        const next = new Set(current)
                        next.delete(entry.approval.approvalId)
                        return next
                      })
                    }
                  }}
                >
                  Show
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {approvals
        .filter((entry) => entry.approval.state !== 'open')
        .map((entry) => (
          <NativeChatWorkerApprovalReceipt key={entry.approval.approvalId} entry={entry} />
        ))}
    </div>
  )
}

/** The pinned stack for a chat's own party; it holds the approvals itself, so the pane does not redraw for them. */
export function NativeChatPartyWorkerApprovalStack({
  party,
  ...stack
}: Omit<Parameters<typeof NativeChatWorkerApprovalStack>[0], 'approvals'> & {
  party: string | null
}): React.JSX.Element | null {
  return (
    <NativeChatWorkerApprovalStack
      approvals={useNativeChatPinnedWorkerApprovals(party, stack.isVisible)}
      {...stack}
    />
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

/** The chat's address its workers report to, when it can coordinate: a local Orca session (v1). */
export function nativeChatWorkerApprovalParty(pane: {
  target: RuntimeClientTarget
  sessionId: string
}): string | null {
  return pane.target.kind === 'local' && isOrcaSessionId(pane.sessionId)
    ? formatOrcaSessionAddress(pane.sessionId)
    : null
}

/** A coordinator chat's closed worker prompts, each in its transcript at the time the worker
 *  asked. Holds them itself, so only the transcript redraws, and only when a receipt changes. */
export function NativeChatWorkerApprovalTimeline({
  party,
  isVisible = true,
  children
}: {
  party: string | null
  isVisible?: boolean
  children: (timedRows: readonly NativeChatTimedRow[]) => React.ReactNode
}): React.ReactNode {
  const receipts = useNativeChatWorkerApprovalReceipts(party, isVisible)
  const timedRows = useMemo(
    () =>
      receipts.map((entry) => ({
        key: `worker-approval:${entry.approval.approvalId}`,
        at: Date.parse(entry.askedAt ?? entry.at),
        node: <NativeChatWorkerApprovalReceipt entry={entry} />
      })),
    [receipts]
  )
  return children(timedRows)
}

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  closeNativeChatWorkerApproval,
  useNativeChatWorkerApprovals,
  type NativeChatWorkerApproval
} from './native-chat-worker-approval-feed'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { NativeChatTimedRow } from '../conversation/slots/native-chat-timed-rows'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/orca-session-address'
import type {
  WorkerApprovalDecision,
  WorkerApprovalOutcome
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

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

/** Workers' open prompts, pinned above the composer, oldest first; a card here never takes focus
 *  or cancels the chat's turn. Several scroll within a bounded height. */
export function NativeChatWorkerApprovalStack({
  approvals,
  target,
  isVisible = true,
  onClosed
}: {
  approvals: readonly NativeChatWorkerApproval[]
  target: RuntimeClientTarget
  /** A hidden pane's countdown stands still; it shows the time again once visible. */
  isVisible?: boolean
  /** Show the prompt closed this way now; null shows it open again. */
  onClosed?: (approvalId: string, outcome: WorkerApprovalOutcome | null) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const open = approvals.filter(({ approval }) => approval.state === 'open')
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set())
  const now = useSecondClock(isVisible && open.some(({ approval }) => approval.expiresAt))
  const answer = useCallback(
    (entry: NativeChatWorkerApproval, decision: WorkerApprovalDecision) => {
      const { approvalId, worker } = entry.approval
      setSubmitting((current) => new Set(current).add(approvalId))
      // The card answers at once, as the chat's own prompt does; only an answer Claude did not take changes it.
      onClosed?.(approvalId, { by: 'person', decision, reason: null, reasonDelivered: false })
      const name = entry.worker.label
      callRuntimeRpc(target, 'orchestration.approvalAnswer', {
        dispatch: worker.dispatchId,
        prompt: approvalId,
        decision,
        ...(decision === 'deny' ? { reason: OWNER_DENY_REASON } : {})
      })
        // A landed answer needs no toast: the card turns into its receipt.
        .catch((error: unknown) => {
          const closed = closedBeforeAnswer(error)
          if (!closed) {
            // Not applied and still open: the card is answerable again.
            onClosed?.(approvalId, null)
            toast.error(
              t('components.native-chat.approval.answerFailed', '{{name}}: {{detail}}', {
                name,
                detail: error instanceof Error ? error.message : String(error)
              })
            )
            return
          }
          // Closed before this answer: the card turns into its receipt now, and the toast says why.
          onClosed?.(approvalId, closed)
          toast.info(
            closed.by === 'worker-ended'
              ? t(
                  'components.native-chat.approval.answerWorkerEnded',
                  '{{name}} has ended, so this prompt is closed',
                  { name }
                )
              : t(
                  'components.native-chat.approval.answerAlreadyClosed',
                  '{{name}}: this prompt had already closed',
                  { name }
                )
          )
        })
        .finally(() =>
          setSubmitting((current) => {
            const next = new Set(current)
            next.delete(approvalId)
            return next
          })
        )
    },
    [onClosed, t, target]
  )
  if (open.length === 0) {
    return null
  }
  return (
    <div
      className="scrollbar-sleek max-h-[40vh] shrink-0 overflow-y-auto"
      data-native-chat-worker-approvals=""
    >
      {open.map((entry) => {
        const { approval } = entry
        const left = workerApprovalTimeLeft(approval.expiresAt, now)
        return (
          <div key={approval.approvalId} data-native-chat-worker-approval={approval.approvalId}>
            <NativeChatApprovalCard
              approval={workerApprovalCard(approval, t)}
              onChoose={(decision) => {
                if (isWorkerApprovalDecision(decision)) {
                  answer(entry, decision)
                }
              }}
              isSubmitting={submitting.has(approval.approvalId)}
              worker={{
                name: entry.worker.label,
                onOpen: () => void openOrchestrationCrewAgent(entry.worker, target)
              }}
              {...(left
                ? {
                    countdown: t(
                      'components.native-chat.approval.countdown',
                      'Claude denies it on its own in {{time}} if nobody answers.',
                      { time: left }
                    )
                  }
                : {})}
              placement="stacked"
            />
          </div>
        )
      })}
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
  const onClosed = useCallback(
    (approvalId: string, outcome: WorkerApprovalOutcome | null) => {
      if (party) {
        closeNativeChatWorkerApproval(party, approvalId, outcome)
      }
    },
    [party]
  )
  return (
    <NativeChatWorkerApprovalStack
      approvals={useNativeChatWorkerApprovals(party)}
      onClosed={onClosed}
      {...stack}
    />
  )
}

/** How a prompt closed when an answer finds it gone: its worker ended, or something else closed it. */
function closedBeforeAnswer(error: unknown): WorkerApprovalOutcome | null {
  const code = error instanceof RuntimeRpcCallError ? error.code : null
  return code === 'dispatch_inactive' || code === 'approval_not_open'
    ? {
        by: code === 'dispatch_inactive' ? 'worker-ended' : 'unknown',
        decision: null,
        reason: null,
        reasonDelivered: false
      }
    : null
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

/** A coordinator chat's answered worker prompts, each in its transcript at the time the worker
 *  asked. Holds the approvals itself, so only the transcript redraws when they change. */
export function NativeChatWorkerApprovalTimeline({
  party,
  children
}: {
  party: string | null
  children: (timedRows: readonly NativeChatTimedRow[]) => React.ReactNode
}): React.ReactNode {
  const approvals = useNativeChatWorkerApprovals(party)
  const timedRows = useMemo(
    () =>
      approvals.flatMap((entry) =>
        entry.approval.state === 'open'
          ? []
          : [
              {
                key: `worker-approval:${entry.approval.approvalId}`,
                at: Date.parse(entry.askedAt ?? entry.at),
                node: <NativeChatWorkerApprovalReceipt entry={entry} />
              }
            ]
      ),
    [approvals]
  )
  return children(timedRows)
}

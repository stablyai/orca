import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { openOrchestrationCrewAgent } from '@/lib/open-agent-message-sender'
import { useOrchestrationCrew } from '@/components/orchestration-crew/use-orchestration-crew'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import { NativeChatResolutionReceipt } from '../prompts/NativeChatResolutionReceipt'
import { NativeChatWorkerLifetimeStrip } from '../worker-lifetime/NativeChatWorkerLifetimeStrip'
import {
  isWorkerApprovalDecision,
  workerApprovalCard,
  workerApprovalReceiptBody,
  workerApprovalReceiptText,
  workerApprovalLapsesAt,
  workerApprovalTimeLeft
} from './worker-approval-card-model'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/orca-session-address'
import type { OrchestrationCrewRow } from '../../../../../shared/orchestration/orchestration-crew'
import type {
  WorkerApprovalDecision,
  WorkerApprovalPayload
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

export type NativeChatWorkerApproval = {
  approval: WorkerApprovalPayload
  at: string
  worker: OrchestrationCrewRow
}

// The person's own Deny: the worker gets this, word for word where its agent takes a message.
const OWNER_DENY_REASON = 'Denied by the owner.'

/** This chat's workers' approvals, from its crew's mailbox rows as soon as they are stored; local only in v1. */
export function useNativeChatWorkerApprovals(
  target: RuntimeClientTarget | null,
  party: string | null
): NativeChatWorkerApproval[] {
  const crew = useOrchestrationCrew(target?.kind === 'local' ? target : null, party)
  const all = useMemo(
    () =>
      crew.sections.managing
        .flatMap((worker) => (worker.approvals ?? []).map((entry) => ({ ...entry, worker })))
        .sort((a, b) => a.at.localeCompare(b.at)),
    [crew]
  )
  const [now, setNow] = useState(Date.now)
  const nextLapse = Math.min(
    ...all.map(({ approval }) => workerApprovalLapsesAt(approval)).filter((at) => at > now)
  )
  useEffect(() => {
    if (!Number.isFinite(nextLapse)) {
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), nextLapse - Date.now())
    return () => clearTimeout(timer)
  }, [nextLapse])
  return useMemo(
    () => all.filter(({ approval }) => workerApprovalLapsesAt(approval) > now),
    [all, now]
  )
}

const cardSelector = (approvalId: string) =>
  `[data-native-chat-worker-approval="${CSS.escape(approvalId)}"]`

/** Open cards and receipts at the end of the conversation; a card here never takes focus or cancels the chat's turn. */
export function NativeChatWorkerApprovalRows({
  approvals,
  target
}: {
  approvals: readonly NativeChatWorkerApproval[]
  target: RuntimeClientTarget
}): React.JSX.Element | null {
  const t = useTranslate()
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set())
  const now = useSecondClock(approvals.some(({ approval }) => approval.expiresAt))
  const answer = useCallback(
    (entry: NativeChatWorkerApproval, decision: WorkerApprovalDecision) => {
      const { approvalId, worker } = entry.approval
      setSubmitting((current) => new Set(current).add(approvalId))
      callRuntimeRpc(target, 'orchestration.approvalAnswer', {
        dispatch: worker.dispatchId,
        prompt: approvalId,
        decision,
        ...(decision === 'deny' ? { reason: OWNER_DENY_REASON } : {})
      })
        .catch((error: unknown) =>
          toast.error(
            t('components.native-chat.approval.answerFailed', '{{name}}: {{detail}}', {
              name: entry.worker.label,
              detail: error instanceof Error ? error.message : String(error)
            })
          )
        )
        .finally(() =>
          setSubmitting((current) => {
            const next = new Set(current)
            next.delete(approvalId)
            return next
          })
        )
    },
    [t, target]
  )
  if (approvals.length === 0) {
    return null
  }
  return (
    <div className="space-y-4 pb-2" data-native-chat-worker-approvals="">
      {approvals.map((entry) => {
        const { approval } = entry
        if (approval.state !== 'open') {
          return (
            <div key={approval.approvalId} className="px-3 sm:px-4">
              <NativeChatResolutionReceipt
                body={workerApprovalReceiptBody(approval, entry.at, t)}
                outcome={{
                  worker: entry.worker.label,
                  text: workerApprovalReceiptText(approval, t),
                  ...(approval.outcome?.by === 'coordinator' && approval.outcome.reason
                    ? { reason: approval.outcome.reason }
                    : {})
                }}
              />
            </div>
          )
        }
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
              placement="transcript"
            />
          </div>
        )
      })}
    </div>
  )
}

/** "N approvals · Show": counts open approvals, and stays up even while the chat has its own prompt. */
export function NativeChatWorkerApprovalStrip({
  approvals,
  rootRef
}: {
  approvals: readonly NativeChatWorkerApproval[]
  rootRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const open = approvals.filter(({ approval }) => approval.state === 'open')
  if (open.length === 0) {
    return null
  }
  return (
    <NativeChatWorkerLifetimeStrip
      text={t('components.native-chat.approval.strip', '{{count}} approvals', {
        count: open.length,
        defaultValue_one: '{{count}} approval'
      })}
      keepOpenLabel={t('components.native-chat.approval.show', 'Show')}
      onKeepOpen={() =>
        rootRef.current
          ?.querySelector(cardSelector(open[0].approval.approvalId))
          ?.scrollIntoView({ block: 'center' })
      }
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

/** A coordinator chat's worker approvals: card rows for its transcript, and the strip above its composer. */
export function useNativeChatWorkerApprovalSlots(
  pane: { target: RuntimeClientTarget; sessionId: string },
  rootRef: React.RefObject<HTMLElement | null>
): { rows: React.ReactNode; strip: React.ReactNode } {
  const approvals = useNativeChatWorkerApprovals(
    pane.target,
    isOrcaSessionId(pane.sessionId) ? formatOrcaSessionAddress(pane.sessionId) : null
  )
  return {
    rows: <NativeChatWorkerApprovalRows approvals={approvals} target={pane.target} />,
    strip: <NativeChatWorkerApprovalStrip approvals={approvals} rootRef={rootRef} />
  }
}

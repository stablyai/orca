import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from '../requests/structured-agent-session-dispatch-rejection'
import type { SubmissionRejectionKind } from './agent-session-failure'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'

/** Preserve markers released clients hide. A write failure keeps the bare marker; its error stays in the log. */
export const LEGACY_REJECTION_MARKERS: Partial<
  Record<SubmissionRejectionKind, (context: AgentSessionFailureWordsContext) => string | undefined>
> = {
  cancelled: () => DISPATCH_REJECTED_CANCELLED,
  writeFailed: () => DISPATCH_REJECTED_WRITE_FAILED,
  queueFull: ({ provider }) =>
    provider === 'codex'
      ? DISPATCH_REJECTED_CODEX_QUEUE_FULL
      : provider === 'claude'
        ? DISPATCH_REJECTED_QUEUE_FULL
        : undefined
}

import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { attemptStructuredAgentSessionSend } from './structured-agent-session-send-attempt'
import {
  findStructuredAgentSessionPendingSend,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'
import {
  beginSend,
  handBack,
  handBackRefused,
  retainUnconfirmed,
  runtimes,
  settleRecorded,
  type StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'

async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    reconcile: runtime.activity.settle,
    beforeIssue: () => {
      runtime.activity.issue()
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      })
    },
    abandoned: () => runtime.abort.signal.aborted || runtimes.get(entry.clientMessageId) !== runtime
  })
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  if (outcome.kind === 'not-sent') {
    handBack(current, outcome.parts)
  } else if (outcome.evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission, 'reply', outcome.cursor)
  } else if (outcome.evidence.kind === 'not-recorded') {
    handBackRefused(current, outcome.evidence.failure)
  } else {
    retainUnconfirmed(current)
  }
}

export function dispatchStructuredAgentSessionSend(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget
): StructuredAgentSessionSent {
  const sent = beginSend(entry, target)
  void attempt(entry)
  return sent
}

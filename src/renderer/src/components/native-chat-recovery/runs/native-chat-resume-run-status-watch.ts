import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import type { StructuredAgentSessionStatusChange } from '@/runtime/native-chat/status/structured-agent-session-status-dispatch'
import { observeResumeRun, type ResumeRun } from './native-chat-resume-run'

/** Capture every frame, even while the dialog is closed or React batches renders. */
export function watchResumeRunStatus(
  current: () => ResumeRun | null,
  publish: (run: ResumeRun) => void,
  target: RuntimeClientTarget = { kind: 'local' }
): () => void {
  const feed = getStructuredAgentSessionStatusFeed(target)
  // A run's chats are fixed when it starts; progress replaces the run object, so key the index by its start.
  let runIndex: { startedAt: number; byId: ReadonlyMap<string, number> } | null = null
  const notice = (change: StructuredAgentSessionStatusChange) => {
    const run = current()
    if (!run) {
      return
    }
    let indices: number[] | undefined
    if (change !== null) {
      if (runIndex?.startedAt !== run.startedAt) {
        runIndex = {
          startedAt: run.startedAt,
          byId: new Map(run.entries.map((entry, index) => [entry.candidate.sessionId, index]))
        }
      }
      const { byId } = runIndex
      indices = Array.from(change, (sessionId) => byId.get(sessionId) ?? -1).filter(
        (index) => index >= 0
      )
      if (indices.length === 0) {
        return
      }
    }
    const snapshot = feed.getSnapshot()
    const next = observeResumeRun(run, (sessionId) => snapshot.get(sessionId), indices)
    if (next !== run) {
      publish(next)
    }
  }
  const unsubscribe = feed.subscribe(notice)
  const deactivate = feed.activate()
  return () => {
    unsubscribe()
    deactivate()
  }
}

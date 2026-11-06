import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusChange
} from '@/runtime/structured-agent-session-status-feed'
import { observeResumeRun, type ResumeRun } from './native-chat-resume-run'

/** Capture every frame, even while the dialog is closed or React batches renders. */
export function watchResumeRunStatus(
  current: () => ResumeRun | null,
  publish: (run: ResumeRun) => void,
  target: RuntimeClientTarget = { kind: 'local' }
): () => void {
  const feed = getStructuredAgentSessionStatusFeed(target)
  // A run's chats are fixed when it starts; progress replaces the run object, so key the ids by its start.
  let runIds: { startedAt: number; ids: ReadonlySet<string> } | null = null
  const notice = (change: StructuredAgentSessionStatusChange) => {
    const run = current()
    if (!run) {
      return
    }
    if (change !== null) {
      if (runIds?.startedAt !== run.startedAt) {
        runIds = {
          startedAt: run.startedAt,
          ids: new Set(run.entries.map((entry) => entry.candidate.sessionId))
        }
      }
      const { ids } = runIds
      if (![...change].some((sessionId) => ids.has(sessionId))) {
        return
      }
    }
    const snapshot = feed.getSnapshot()
    const next = observeResumeRun(run, (sessionId) => snapshot.get(sessionId))
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

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
  // Run entries are fixed per run object, so their ids are built once rather than per host tick.
  const runIds = new WeakMap<ResumeRun, Set<string>>()
  const notice = (change: StructuredAgentSessionStatusChange) => {
    const run = current()
    if (!run) {
      return
    }
    if (change !== null) {
      const ids = runIds.get(run) ?? new Set(run.entries.map((entry) => entry.candidate.sessionId))
      runIds.set(run, ids)
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

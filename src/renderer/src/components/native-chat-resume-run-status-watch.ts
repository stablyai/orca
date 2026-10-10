import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { observeResumeRun, type ResumeRun } from './native-chat-resume-run'

/** Capture every frame, even while the dialog is closed or React batches renders. Watches the feed
 *  of the machine running the resume, since its host publishes each chat's progress. */
export function watchResumeRunStatus(
  target: RuntimeClientTarget,
  current: () => ResumeRun | null,
  publish: (run: ResumeRun) => void
): () => void {
  const feed = getStructuredAgentSessionStatusFeed(target)
  const notice = () => {
    const run = current()
    if (!run) {
      return
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

import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

// Why: xterm's WriteBuffer._innerWrite invokes write-completion callbacks with
// no try/catch; a synchronous throw skips the loop's tail re-schedule, and
// write() only re-arms processing when the buffer is EMPTY — which a stalled
// buffer never is again. One escaping throw therefore permanently freezes the
// pane: output stops rendering and a pending replay guard never releases, so
// the pane silently eats every keystroke while the shell stays alive
// (Discord #performance / issue #2836). Verified against the vendored xterm
// 6.1.0-beta.287 in xterm-write-buffer-stall.repro.test.ts.
const MAX_REPORTS_PER_CONTEXT = 5
const reportCountsByContext = new Map<string, number>()

/**
 * Run one step of a write-completion callback so a synchronous throw cannot
 * escape into xterm's WriteBuffer. Steps are guarded individually so an
 * earlier step's failure (e.g. a WebGL refresh during viewport settle) cannot
 * starve a later step (e.g. the replay-guard release).
 */
export function runGuardedWriteCompletionStep(context: string, step: () => void): void {
  try {
    step()
  } catch (error: unknown) {
    const reported = reportCountsByContext.get(context) ?? 0
    if (reported >= MAX_REPORTS_PER_CONTEXT) {
      return
    }
    reportCountsByContext.set(context, reported + 1)
    console.error(`[terminal] write-completion step "${context}" threw`, error)
    recordRendererCrashBreadcrumb('terminal_write_completion_error', {
      context,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  }
}

export function _resetWriteCompletionReportsForTests(): void {
  reportCountsByContext.clear()
}

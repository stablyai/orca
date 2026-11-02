import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

// WriteBuffer._innerWrite does not catch completion throws; they skip rescheduling while write() only rearms empty queues, permanently freezing output/input despite a live shell (#2836). Pinned against xterm 6.1.0-beta.287 in xterm-write-buffer-stall.repro.test.ts.
const MAX_REPORTS_PER_CONTEXT = 5
const reportCountsByContext = new Map<string, number>()

/** Guard each completion step separately so throws cannot wedge WriteBuffer and earlier settle failures cannot starve replay-guard release. */
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

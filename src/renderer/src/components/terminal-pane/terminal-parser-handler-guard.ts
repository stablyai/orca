import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

// Why: xterm's EscapeSequenceParser invokes custom CSI/OSC handlers
// synchronously inside WriteBuffer._innerWrite, which has no try/catch. A
// handler throw skips the loop's tail re-schedule, and write() only re-arms
// on an EMPTY buffer — one throw permanently freezes the pane (output stops;
// a pending replay guard never releases and silently eats keystrokes).
// Verified against vendored xterm 6.1.0-beta.287 in
// xterm-write-buffer-stall.repro.test.ts. Same escape class as
// terminal-link-provider-guard.ts, applied to parser handlers.
const MAX_REPORTS_PER_HANDLER = 5
const reportCountsByHandler = new Map<string, number>()

/**
 * Wrap a custom parser handler so a synchronous throw is reported and
 * degraded to "not handled" (xterm falls through to the previous/default
 * handler) instead of wedging the terminal's write pipeline.
 */
export function guardParserHandler<HandlerArgs extends unknown[]>(
  handlerName: string,
  handler: (...args: HandlerArgs) => boolean
): (...args: HandlerArgs) => boolean {
  return (...args: HandlerArgs): boolean => {
    try {
      return handler(...args)
    } catch (error: unknown) {
      const reported = reportCountsByHandler.get(handlerName) ?? 0
      if (reported < MAX_REPORTS_PER_HANDLER) {
        reportCountsByHandler.set(handlerName, reported + 1)
        console.error(`[terminal] parser handler "${handlerName}" threw`, error)
        recordRendererCrashBreadcrumb('terminal_parser_handler_error', {
          handler: handlerName,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        })
      }
      return false
    }
  }
}

export function _resetParserHandlerReportsForTests(): void {
  reportCountsByHandler.clear()
}

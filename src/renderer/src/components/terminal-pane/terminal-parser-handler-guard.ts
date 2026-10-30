import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

// Custom CSI/OSC throws escape xterm’s write loop, skip rescheduling and permanently freeze a nonempty buffer, latching replay/input guards (xterm-write-buffer-stall.repro.test.ts).
const MAX_REPORTS_PER_HANDLER = 5
const reportCountsByHandler = new Map<string, number>()

/** Report synchronous handler throws and fall through to prior/default parsing instead of wedging the write pipeline. */
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

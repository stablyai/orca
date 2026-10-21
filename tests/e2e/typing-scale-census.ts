import type { Page } from '@stablyai/playwright-test'
import type {
  TypingDiagnosticBridge,
  TypingLatencyReport
} from '../../src/renderer/src/lib/typing-latency/diagnostic'

/** Reads the existing census without enabling per-keystroke diagnostic instrumentation. */
export async function readTypingScaleCensus(
  page: Page
): Promise<TypingLatencyReport['census'] | null> {
  return page.evaluate(() => {
    const target: Window & { __orcaTypingDiagnostic?: TypingDiagnosticBridge } = window
    return target.__orcaTypingDiagnostic?.report().census ?? null
  })
}

import type { Page } from '@stablyai/playwright-test'
import { getTerminalContent } from './terminal'

export const KEY_LATENCY_SAMPLES = 'abcdefghijklmnop'
export const MAX_MEDIAN_KEY_LATENCY_MS = 250
export const MAX_WORST_KEY_LATENCY_MS = 1_000

export function interactivePromptScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('\\x1b]0;Terminal typing benchmark\\x07')
process.stdout.write('TYPING_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('\\r\\x1b[2KInteractive prompt ' + seq + ': ' + char + ' TYPING_KEY_${runId}_' + seq + '\\n')
  }
})
`
}

export async function waitForMarkerLatency(
  page: Page,
  marker: string,
  timeoutMs: number
): Promise<number> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if ((await getTerminalContent(page, 12_000)).includes(marker)) {
      return performance.now() - start
    }
    await page.waitForTimeout(5)
  }
  throw new Error(`Timed out waiting for terminal marker ${marker}`)
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

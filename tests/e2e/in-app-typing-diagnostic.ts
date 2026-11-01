import type { Page } from '@stablyai/playwright-test'

type TypingDiagnosticWindow = Window & {
  __orcaTypingDiagnostic?: {
    start: () => string
    stop: () => string
    report: () => unknown
  }
}

/** Runs the shipped renderer probe beside the bench: it splits the renderer-side phases the PTY sidecar cannot see. */
export async function withInAppTypingDiagnostic<T>(
  page: Page,
  enabled: boolean,
  run: () => Promise<T>
): Promise<{ result: T; report: unknown }> {
  if (!enabled) {
    return { result: await run(), report: null }
  }
  const started = await page.evaluate(() => {
    const target: TypingDiagnosticWindow = window
    return target.__orcaTypingDiagnostic?.start() ?? null
  })
  if (started === null) {
    return { result: await run(), report: { available: false } }
  }
  try {
    const result = await run()
    const report = await page.evaluate(() => {
      const target: TypingDiagnosticWindow = window
      target.__orcaTypingDiagnostic?.stop()
      return target.__orcaTypingDiagnostic?.report() ?? null
    })
    return { result, report }
  } finally {
    await page
      .evaluate(() => {
        const target: TypingDiagnosticWindow = window
        target.__orcaTypingDiagnostic?.stop()
      })
      .catch(() => undefined)
  }
}

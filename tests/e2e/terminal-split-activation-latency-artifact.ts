import { writeFileSync } from 'node:fs'

const MAX_ERROR_TEXT_LENGTH = 200
// Absolute POSIX/Windows paths, which routinely appear inside cleanup error text.
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)[\w.\-\\/]{2,}/g

function redactText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return value.replace(ABSOLUTE_PATH, '<path>').slice(0, MAX_ERROR_TEXT_LENGTH)
}

function redactSamples(samples: unknown): unknown {
  if (!Array.isArray(samples)) {
    return samples
  }
  return samples.map((sample) =>
    sample && typeof sample === 'object' && 'cleanupError' in sample
      ? { ...sample, cleanupError: redactText((sample as { cleanupError: unknown }).cleanupError) }
      : sample
  )
}

/**
 * Strips machine-identifying data so a report can be shared verbatim: the seeded
 * repo lives under an operator-overridable path, and cleanup/abort text is
 * unbounded free-form error output.
 */
export function sanitizeTerminalSplitLatencyReport(
  report: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...report,
    testRepoPath: '<test-repo>',
    abortReason: redactText(report.abortReason),
    warmupSamples: redactSamples(report.warmupSamples),
    measuredSamples: redactSamples(report.measuredSamples)
  }
}

/** Persist the benchmark report so a passing run cannot silently lose its artifact. */
export function writeTerminalSplitLatencyArtifact(outputPath: string, body: string): void {
  try {
    writeFileSync(outputPath, body, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[terminal-split-activation-latency] unable to write ${outputPath}: ${message}`,
      { cause: error }
    )
  }
}

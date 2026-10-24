export function log(line: string): void {
  console.log(`[editor-mirror-echo] ${line}`)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Re-runs `check` every `intervalMs` for `durationMs`; the first failing expectation ends it. */
export async function soak(
  label: string,
  durationMs: number,
  intervalMs: number,
  check: (elapsedMs: number) => Promise<void>
): Promise<void> {
  const startedAt = Date.now()
  let rounds = 0
  while (Date.now() - startedAt < durationMs) {
    await check(Date.now() - startedAt)
    rounds += 1
    await sleep(intervalMs)
  }
  log(`soak "${label}" held for ${durationMs}ms across ${rounds} samples`)
}

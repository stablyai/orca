import { useAppStore } from '@/store'

const MAX_PROVISIONING_LOG_CHARS = 12_000

export function appendProvisioningWarnings(
  creationId: string,
  warnings: readonly { message: string; remediation?: string }[]
): void {
  if (warnings.length === 0) {
    return
  }
  const text = warnings
    .map((warning) =>
      warning.remediation
        ? `Warning: ${warning.message}\n${warning.remediation}\n`
        : `Warning: ${warning.message}\n`
    )
    .join('')
  appendProvisioningLog(creationId, text)
}

export function appendProvisioningLog(creationId: string, chunk: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  // Why: recipe stdout contains the structured result with pairing credentials;
  // only stderr is displayed, and the in-memory tail is bounded.
  store.updatePendingWorktreeCreation(
    creationId,
    appendStampedLog(
      entry.provisioningLog ?? '',
      entry.provisioningLogStamps ?? [],
      chunk,
      Date.now()
    )
  )
}

function countLines(text: string): number {
  // A trailing newline opens a line that has no output yet, so it gets no stamp.
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** Appends a chunk and stamps each newly started line with `now`, trimming both to the bounded tail. */
export function appendStampedLog(
  log: string,
  stamps: readonly number[],
  chunk: string,
  now: number
): { provisioningLog: string; provisioningLogStamps: number[] } {
  const full = `${log}${chunk}`
  const lineCount = countLines(full)
  const nextStamps = stamps.slice(0, lineCount)
  while (nextStamps.length < lineCount) {
    nextStamps.push(now)
  }
  const tail = full.slice(-MAX_PROVISIONING_LOG_CHARS)
  const dropped = full.slice(0, full.length - tail.length)
  const droppedLines = dropped === '' ? 0 : dropped.split('\n').length - 1
  return { provisioningLog: tail, provisioningLogStamps: nextStamps.slice(droppedLines) }
}

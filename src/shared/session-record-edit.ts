let copyObserver: ((duration: number) => void) | undefined

/** Instrument the actual spread, without timing or allocating when instrumentation is off. */
export function observeSessionRecordCopies(observer?: (duration: number) => void): () => void {
  const previous = copyObserver
  copyObserver = observer
  return () => {
    copyObserver = previous
  }
}

export function copySessionRecord<T>(
  source: Readonly<Record<string, T>> | undefined,
  set: Readonly<Record<string, T>> = {},
  remove: readonly string[] = []
): Record<string, T> {
  const start = copyObserver ? performance.now() : 0
  const next = { ...source, ...set }
  for (const key of remove) {
    delete next[key]
  }
  copyObserver?.(performance.now() - start)
  return next
}

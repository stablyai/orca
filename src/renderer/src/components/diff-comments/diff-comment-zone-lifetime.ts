// Zone resources retire before deferred React root unmount, including during a pooled rebind.
export function untilDiffCommentZoneRemoved(
  signal: AbortSignal | undefined,
  cleanup: () => void
): () => void {
  let active = true
  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    signal?.removeEventListener('abort', dispose)
    cleanup()
  }
  signal?.addEventListener('abort', dispose, { once: true })
  if (signal?.aborted) {
    dispose()
  }
  return dispose
}

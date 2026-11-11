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

export function observeDiffCommentZoneSize(
  signal: AbortSignal | undefined,
  node: Element,
  onResize: () => void,
  onDisconnect?: () => void
): () => void {
  const observer = new ResizeObserver(onResize)
  observer.observe(node)
  return untilDiffCommentZoneRemoved(signal, () => {
    observer.disconnect()
    onDisconnect?.()
  })
}

export function listenForDiffCommentZoneMouseDown(
  signal: AbortSignal | undefined,
  listener: (event: MouseEvent) => void
): () => void {
  document.addEventListener('mousedown', listener)
  return untilDiffCommentZoneRemoved(signal, () =>
    document.removeEventListener('mousedown', listener)
  )
}

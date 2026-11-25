export function scheduleOrphanedRemoteRuntimeSocketClose(
  isOrphaned: () => boolean,
  close: () => void
): void {
  queueMicrotask(() => {
    if (isOrphaned()) {
      close()
    }
  })
}

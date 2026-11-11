import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function declareFreshSpawnSerializer(session: ConnectPanePtySession): {
  preSignalPromise: Promise<number | null>
  clearPreSignaledSerializer: () => void
} {
  // Declare before spawn to suppress daemon seeding; ordered Electron IPC needs no await, and the captured generation later settles/clears ownership (docs/mobile-prefer-renderer-scrollback.md).
  const preSignalPromise = session.runtimeEnvironmentId
    ? Promise.resolve(null)
    : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
  const clearPreSignaledSerializer = (): void => {
    // Slow serializer declarations must not block successor spawns; finish disposed pre-bind cleanup independently.
    void preSignalPromise.then((gen) => {
      if (typeof gen === 'number') {
        void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
      }
    })
  }

  return { preSignalPromise, clearPreSignaledSerializer }
}

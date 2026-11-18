import {
  bufferPreHandlerPtyLaunchTyped,
  takePreHandlerPtyLaunchTyped
} from './pty-pre-handler-buffer'

type LaunchTypedWatcher = { incarnationId?: string; onTyped: () => void }

const launchTypedWatchers = new Map<string, LaunchTypedWatcher>()

function belongsTo(watcher: LaunchTypedWatcher, incarnationId: string | undefined): boolean {
  return (
    watcher.incarnationId === undefined ||
    incarnationId === undefined ||
    watcher.incarnationId === incarnationId
  )
}

/** The host typed this PTY's startup launch itself; at most once per process. */
export function deliverPtyLaunchTyped(payload: { id: string; incarnationId: string }): void {
  const watcher = launchTypedWatchers.get(payload.id)
  if (!watcher) {
    bufferPreHandlerPtyLaunchTyped(payload.id, payload.incarnationId)
    return
  }
  if (!belongsTo(watcher, payload.incarnationId)) {
    return
  }
  launchTypedWatchers.delete(payload.id)
  watcher.onTyped()
}

/** One-shot; a fact that arrived before the watch runs `onTyped` immediately. */
export function watchPtyLaunchTyped(
  ptyId: string,
  incarnationId: string | undefined,
  onTyped: () => void
): () => void {
  if (takePreHandlerPtyLaunchTyped(ptyId, incarnationId)) {
    onTyped()
    return () => {}
  }
  const watcher: LaunchTypedWatcher = { incarnationId, onTyped }
  launchTypedWatchers.set(ptyId, watcher)
  return () => {
    if (launchTypedWatchers.get(ptyId) === watcher) {
      launchTypedWatchers.delete(ptyId)
    }
  }
}

/** An exited process can no longer have its launch typed. */
export function forgetPtyLaunchTyped(ptyId: string, incarnationId?: string): void {
  const watcher = launchTypedWatchers.get(ptyId)
  if (watcher && belongsTo(watcher, incarnationId)) {
    launchTypedWatchers.delete(ptyId)
  }
}

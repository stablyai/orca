import {
  createSessionWriteSubscriber,
  type SessionWriteSubscriberDeps
} from './session-write-subscriber'
import type { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'
import {
  keyedSessionWriteReady,
  patchWorkspaceSessionEntriesByHost
} from './workspace-session-keyed-host-write'

/** The window's debounced session saves: each host's slice goes to its own partition, and a
 *  title-only change sends just its keys when main already holds the rest. */
export function subscribeWorkspaceSessionHostWrites({
  store,
  api,
  acknowledged,
  onPersistError,
  debounceMs
}: Pick<SessionWriteSubscriberDeps, 'store' | 'onPersistError' | 'debounceMs'> & {
  api: SessionApi
  acknowledged: AcknowledgedWorkspaceSessionEntries
}): () => void {
  return createSessionWriteSubscriber({
    store,
    onPersistError,
    debounceMs,
    persist: ({ patch, fields }) =>
      patchWorkspaceSessionByHost(api, patch, store.getState(), acknowledged, fields).written,
    persistKeyed: (write) =>
      patchWorkspaceSessionEntriesByHost(api, write, store.getState(), acknowledged)?.written ??
      null,
    keyedWriteReady: (fields) => keyedSessionWriteReady(api, store.getState(), acknowledged, fields)
  })
}

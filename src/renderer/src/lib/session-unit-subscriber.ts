import type { AppState } from '../store/types'
import type { SessionSourceDiscovery } from './session-source-fields'
import { SessionSourceReceipts } from './session-source-receipts'
import { shouldPersistWorkspaceSession } from './workspace-session'
import { SessionUnitProjection } from './session-unit-projection'
import type { SessionUnitWriter } from './session-unit-writer'

export function createSessionUnitSubscriber({
  store,
  writer,
  debounceMs = 150,
  onPersistError
}: {
  store: {
    getState(): AppState
    getSessionSourceReceipt(): SessionSourceDiscovery | undefined
    subscribe(listener: (state: AppState) => void): () => void
  }
  writer: SessionUnitWriter
  debounceMs?: number
  onPersistError?: (error: unknown) => void
}): () => void {
  let discovered = store.getState()
  let projection: SessionUnitProjection | undefined
  let full = true
  let retry = false
  let writing = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = new SessionSourceReceipts()
  const arm = (): void => {
    if (disposed || writing || timer || !shouldPersistWorkspaceSession(store.getState())) {
      return
    }
    timer = setTimeout(flush, debounceMs)
  }
  const flush = (): void => {
    timer = undefined
    if (
      disposed ||
      writing ||
      !shouldPersistWorkspaceSession(store.getState()) ||
      (!full && !retry && !pending.size)
    ) {
      return
    }
    const state = store.getState()
    const receipts = pending
    pending = new SessionSourceReceipts()
    projection ??= new SessionUnitProjection(state)
    const update = full
      ? projection.full(state)
      : projection.update(state, receipts.take(discovered, state))
    discovered = state
    full = false
    retry = false
    writing = true
    void writer.write(update, state).then(
      () => {
        writing = false
        if (pending.size || full) {
          arm()
        }
      },
      (error: unknown) => {
        writing = false
        retry = true
        onPersistError?.(error)
      }
    )
  }
  const unsubscribe = store.subscribe(() => {
    const receipt = store.getSessionSourceReceipt()
    if (receipt) {
      pending.add(receipt)
    }
    const changed = Boolean(receipt?.changes.size)
    if (changed && timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (pending.size || full || retry) {
      arm()
    }
  })
  arm()
  return () => {
    disposed = true
    writer.dispose()
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
    }
    pending = new SessionSourceReceipts()
  }
}

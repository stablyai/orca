import type {
  ClaudePaneAssignedEvent,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'

export type ClaudePaneAccountAssignment = {
  label: string
  email: string
  accountId: string
}

const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, ClaudePaneAccountAssignment> = new Map()
let subscribers = 0
let stopEvents: (() => void) | null = null
let startId = 0

function emit(next: ReadonlyMap<string, ClaudePaneAccountAssignment>): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

function applyEvent(
  current: ReadonlyMap<string, ClaudePaneAccountAssignment>,
  event: ClaudePaneAssignedEvent
): ReadonlyMap<string, ClaudePaneAccountAssignment> {
  const next = new Map(current)
  if (!event.accountId) {
    next.delete(event.ptyId)
    return next
  }
  next.set(event.ptyId, {
    accountId: event.accountId,
    label: event.label,
    email: event.email
  })
  return next
}

function fromList(
  state: ClaudeRateLimitAccountsState
): ReadonlyMap<string, ClaudePaneAccountAssignment> {
  const next = new Map<string, ClaudePaneAccountAssignment>()
  for (const pane of state.paneAccounts ?? []) {
    next.set(pane.ptyId, {
      accountId: pane.accountId,
      label: pane.label,
      email: pane.email
    })
  }
  return next
}

function start(): void {
  const api = window.api?.claudeAccounts
  if (!api || typeof api.list !== 'function' || typeof api.onPaneAssigned !== 'function') {
    return
  }
  const id = ++startId
  const events: ClaudePaneAssignedEvent[] = []
  let listed = false
  stopEvents = api.onPaneAssigned((event) => {
    if (!listed) {
      events.push(event)
      return
    }
    emit(applyEvent(snapshot, event))
  })
  void api
    .list()
    .then((state) => {
      if (id !== startId) {
        return
      }
      let next = fromList(state)
      let applied = 0
      for (;;) {
        while (applied < events.length) {
          const event = events[applied]
          applied += 1
          if (event) {
            next = applyEvent(next, event)
          }
        }
        if (listed) {
          break
        }
        listed = true
      }
      events.length = 0
      emit(next)
    })
    .catch(() => {
      if (id !== startId) {
        return
      }
      let next = snapshot
      const pending = events.slice()
      for (const event of pending) {
        next = applyEvent(next, event)
      }
      listed = true
      for (const event of events.slice(pending.length)) {
        next = applyEvent(next, event)
      }
      events.length = 0
      emit(next)
    })
}

function stop(): void {
  startId += 1
  stopEvents?.()
  stopEvents = null
}

export function subscribeClaudePaneAccounts(listener: () => void): () => void {
  listeners.add(listener)
  subscribers += 1
  if (subscribers === 1) {
    start()
  }
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0) {
      stop()
    }
  }
}

export function getClaudePaneAccountSnapshot(): ReadonlyMap<string, ClaudePaneAccountAssignment> {
  return snapshot
}

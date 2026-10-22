import type { RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

/**
 * A host-owned state per subject, pushed by revision. While any surface observes a subject, one
 * subscription carries the host's state, idle included, so another client's change shows up too;
 * the last surface leaving ends it.
 */

export type RevisionedHostSnapshot<S> =
  | { kind: 'unknown' }
  /** No answer yet and the last read failed: says nothing about the host's state. */
  | { kind: 'readFailed' }
  | { kind: 'known'; state: S }

type Entry<Subject, S> = {
  subject: Subject
  snapshot: RevisionedHostSnapshot<S>
  observers: number
  /** Bumped by every subscribe and every loss; a frame from another generation is stale. */
  generation: number
  /** The generation the shown state came from: revisions only order one subscription's frames. */
  shownGeneration: number
  stream: { unsubscribe: () => void } | null
  retry: ReturnType<typeof setTimeout> | null
  failures: number
}

const UNKNOWN = { kind: 'unknown' } as const

export function createRevisionedHostStateStore<Subject, S extends { revision: number }>(options: {
  key: (subject: Subject) => string
  /** Subjects with the same host key and a different key answer for a restarted host. */
  hostKey: (subject: Subject) => string
  /** A full state on subscribe, then one per newer revision, until unsubscribed or lost. */
  subscribe: (
    subject: Subject,
    handlers: RuntimeRpcSubscriptionHandlers
  ) => Promise<{ unsubscribe: () => void }>
}) {
  const entries = new Map<string, Entry<Subject, S>>()
  const listeners = new Set<() => void>()

  const setSnapshot = (entry: Entry<Subject, S>, snapshot: RevisionedHostSnapshot<S>): void => {
    entry.snapshot = snapshot
    listeners.forEach((listener) => listener())
  }

  const entryFor = (subject: Subject): Entry<Subject, S> => {
    const key = options.key(subject)
    let entry = entries.get(key)
    if (!entry) {
      // A restarted host runtime answers under a new key; the old one's answer is stale.
      for (const [otherKey, other] of entries) {
        if (other.observers === 0 && options.hostKey(other.subject) === options.hostKey(subject)) {
          entries.delete(otherKey)
        }
      }
      entry = {
        subject,
        snapshot: UNKNOWN,
        observers: 0,
        generation: 0,
        shownGeneration: 0,
        stream: null,
        retry: null,
        failures: 0
      }
      entries.set(key, entry)
    }
    return entry
  }

  const accept = (entry: Entry<Subject, S>, state: S, generation: number): void => {
    // A new subscription may reach a restarted host whose revisions start again at 0.
    if (
      entry.snapshot.kind !== 'known' ||
      generation !== entry.shownGeneration ||
      entry.snapshot.state.revision < state.revision
    ) {
      entry.shownGeneration = generation
      setSnapshot(entry, { kind: 'known', state })
    }
  }

  const isState = (value: unknown): value is S =>
    typeof value === 'object' &&
    value !== null &&
    'revision' in value &&
    typeof value.revision === 'number'

  const close = (entry: Entry<Subject, S>): void => {
    entry.generation += 1
    entry.stream?.unsubscribe()
    entry.stream = null
    if (entry.retry) {
      clearTimeout(entry.retry)
      entry.retry = null
    }
  }

  const open = (entry: Entry<Subject, S>): void => {
    close(entry)
    const { generation } = entry
    const current = (): boolean => entry.observers > 0 && entry.generation === generation
    const lost = (): void => {
      if (!current()) {
        return
      }
      close(entry)
      // A known answer stays through a blip; only a first read failing changes what is shown.
      if (entry.snapshot.kind !== 'known') {
        setSnapshot(entry, { kind: 'readFailed' })
      }
      entry.failures += 1
      const delay = Math.min(30_000, 1000 * 2 ** (entry.failures - 1))
      entry.retry = setTimeout(() => open(entry), delay)
    }
    void options
      .subscribe(entry.subject, {
        onEvent: (result) => {
          if (current() && isState(result)) {
            entry.failures = 0
            accept(entry, result, generation)
          }
        },
        onError: lost,
        onClose: lost
      })
      .then((opened) => {
        if (current()) {
          entry.stream = opened
        } else {
          opened.unsubscribe()
        }
      }, lost)
  }

  return {
    read: (subject: Subject): RevisionedHostSnapshot<S> =>
      entries.get(options.key(subject))?.snapshot ?? UNKNOWN,
    /** Subscribes while at least one shown surface observes `subject`. Returns the release. */
    observe: (subject: Subject): (() => void) => {
      const entry = entryFor(subject)
      entry.observers += 1
      if (entry.observers === 1) {
        entry.failures = 0
        open(entry)
      }
      return () => {
        entry.observers -= 1
        if (entry.observers === 0) {
          close(entry)
        }
      }
    },
    /** Resubscribes a lost stream at once, e.g. when the host answers again after an outage. */
    wake: (subject: Subject): void => {
      const entry = entries.get(options.key(subject))
      if (entry?.retry) {
        entry.failures = 0
        open(entry)
      }
    },
    /** Shows an action's reply, ordered by revision with the subscription's frames. */
    applyReply: async (subject: Subject, request: () => Promise<S>): Promise<void> => {
      const entry = entryFor(subject)
      const { generation } = entry
      const state = await request()
      // A reply that crossed a resubscribe is stale; the new subscription's snapshot governs.
      if (entry.generation === generation) {
        accept(entry, state, generation)
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

import type { PtyTransport } from './pty-transport-types'

export type PtyInputSource = Pick<
  PtyTransport,
  'sendInput' | 'sendInputImmediate' | 'sendInputAccepted' | 'claimViewport'
> & {
  readonly ptyId: string
  readonly endpoint?: { handle: string; incarnationId: string | null; host?: string | null }
  isCurrent: () => boolean
}

export type PtyInputSourceObserver = {
  beforeChange: () => void
  afterChange: (source: PtyInputSource | null) => void
}

export type PtyInputSourceTransition = {
  owns: () => boolean
  settle: () => void
  retire: () => void
  install: (adopted?: boolean) => void
  notify: () => void
}

function observeSafely(callback: () => void): void {
  try {
    callback()
  } catch (error) {
    console.warn('Terminal input source observer failed', error)
  }
}

/** The transport owns one record; synchronous transition handles cannot revive a retired record. */
export function createPtyInputSourceBinding<Endpoint>(options: {
  same: (previous: Endpoint, next: Endpoint) => boolean
  refine: (previous: Endpoint, next: Endpoint) => Endpoint
  unavailable?: (previous: Endpoint, next: Endpoint) => boolean
  create: (endpoint: () => Endpoint, isCurrent: () => boolean) => PtyInputSource
}) {
  type Record = { endpoint: Endpoint; source?: PtyInputSource; live: boolean }
  let current: Record | null = null
  let observer: PtyInputSourceObserver | null = null
  let transition = 0
  const value = (): PtyInputSource | null => (current?.live ? (current.source ?? null) : null)
  const begin = (next: Endpoint | null, unavailable = false): PtyInputSourceTransition => {
    const previous = current
    const version = ++transition
    const owns = (): boolean => version === transition
    const compatible =
      previous?.live === true && next !== null && options.same(previous.endpoint, next)
    let settled = false
    let installed = false
    if (
      previous &&
      !compatible &&
      (unavailable || (next !== null && options.unavailable?.(previous.endpoint, next)))
    ) {
      previous.live = false
    }
    return {
      owns,
      settle: () => {
        if (owns() && !compatible && !settled) {
          settled = true
          if (previous) {
            observeSafely(() => observer?.beforeChange())
          }
        }
      },
      retire: () => {
        if (owns() && !compatible && previous) {
          previous.live = false
        }
      },
      install: (adopted = true) => {
        if (!owns()) {
          return
        }
        if (adopted && compatible && previous && next !== null) {
          previous.endpoint = options.refine(previous.endpoint, next)
        } else {
          if (previous) {
            previous.live = false
          }
          current = null
          if (adopted && next !== null) {
            const record: Record = { endpoint: next, live: true }
            record.source = options.create(
              () => record.endpoint,
              () => record.live && current === record
            )
            current = record
          }
        }
        installed = true
      },
      notify: () => {
        if (owns() && installed && !compatible) {
          observeSafely(() => observer?.afterChange(value()))
        }
      }
    }
  }
  return {
    current: value,
    version: () => transition,
    invalidate: () => observeSafely(() => observer?.beforeChange()),
    begin,
    change(next: Endpoint | null, adopt: () => void, unavailable = false): boolean {
      const pending = begin(next, unavailable)
      pending.settle()
      pending.retire()
      if (!pending.owns()) {
        return false
      }
      let adopted = false
      try {
        adopt()
        adopted = true
      } finally {
        pending.install(adopted)
        pending.notify()
      }
      return adopted && pending.owns()
    },
    observe(next: PtyInputSourceObserver) {
      observer = next
      observeSafely(() => next.afterChange(value()))
      return {
        dispose: () => {
          if (observer === next) {
            observer = null
          }
        }
      }
    }
  }
}

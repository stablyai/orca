/** What a retired operation's pending awaits reject with; never a caller-visible error. */
export const GENERATED_INPUT_RETIRED = Symbol('generated-input-retired')

/** The approved wait-through-dialog budget for a request whose caller set none, armed when its
 *  queue turn opens (after any permission hold or earlier prompt main also waited through). */
export const GENERATED_INPUT_TURN_BUDGET_MS = 60_000

export type GeneratedInputOutcomeKind = 'delivered' | 'staged' | 'unconfirmed' | 'not-sent'

/**
 * One generated request's lifetime, created where the request is accepted and carried unchanged
 * through every step below it: the absolute deadline, the abort, write progress and the one
 * outcome. Once retired nothing waiting on it resumes into a write, and a late answer cannot change
 * a settled outcome.
 */
export class GeneratedInputLifetime {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly progress = { pending: 0, accepted: 0, textDone: false, enter: false }
  private settled = false
  private resolveOutcome!: (outcome: GeneratedInputOutcomeKind) => void
  /** Settles once: at the operation's verdict, or from progress at retirement. */
  readonly outcome = new Promise<GeneratedInputOutcomeKind>((resolve) => {
    this.resolveOutcome = resolve
  })
  private textStarted = false
  private parent: GeneratedInputLifetime | null = null
  deadline: number | null

  constructor(options: {
    /** Absolute; null arms the turn budget when the queue turn opens. */
    deadline: number | null
    /** Ends the request at any point. */
    signal?: AbortSignal
    /** The caller stopped waiting: ends the request only before its text is written. */
    untilTextSignal?: AbortSignal
    submit: boolean
  }) {
    this.submit = options.submit
    this.deadline = null
    if (options.deadline !== null) {
      this.arm(options.deadline)
    }
    this.follow(options.signal, () => true)
    this.follow(options.untilTextSignal, () => !this.textStarted)
  }

  private readonly submit: boolean

  /** One delivery attempt of this request (a permission hold can return the request to its
   *  hold before any byte): same deadline and abort, its own progress and outcome. */
  attempt(): GeneratedInputLifetime {
    const child = new GeneratedInputLifetime({
      deadline: this.deadline,
      signal: this.signal,
      submit: this.submit
    })
    child.parent = this
    return child
  }

  /** Ends the request when `signal` aborts (the target's lifecycle, a takeover). */
  endOn(signal: AbortSignal | undefined): void {
    this.follow(signal, () => true)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get retired(): boolean {
    return this.controller.signal.aborted
  }

  /** Fixes the deadline once; later calls keep the first. */
  arm(deadline: number): void {
    if (this.deadline !== null || this.retired) {
      return
    }
    this.deadline = deadline
    this.timer = setTimeout(() => this.retire(), Math.max(0, deadline - Date.now()))
    this.parent?.arm(deadline)
  }

  /** Ends the request; its outcome follows from what was written. */
  retire(): void {
    if (this.retired) {
      return
    }
    clearTimeout(this.timer)
    this.controller.abort()
    // An abort raised inside a write is read after the writer records whether it was taken.
    queueMicrotask(() => this.settle())
  }

  /** The operation's own verdict; later settlement is ignored. */
  settle(): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.resolveOutcome(this.fromProgress())
  }

  fromProgress(): GeneratedInputOutcomeKind {
    const { progress } = this
    if (progress.enter) {
      return 'delivered'
    }
    if (progress.textDone && !this.submit) {
      return 'staged'
    }
    return progress.accepted > 0 || progress.pending > 0 ? 'unconfirmed' : 'not-sent'
  }

  /** Call synchronously as a frame's bytes are handed over; report whether they were taken. */
  dispatching(enter: boolean): (taken: boolean | 'unknown') => void {
    if (this.retired) {
      throw GENERATED_INPUT_RETIRED
    }
    this.markTextStarted()
    this.progress.pending += 1
    return (taken) => {
      if (taken === 'unknown') {
        return
      }
      this.progress.pending -= 1
      if (taken) {
        this.progress.accepted += 1
        this.progress.enter ||= enter
      }
    }
  }

  private markTextStarted(): void {
    this.textStarted = true
    this.parent?.markTextStarted()
  }

  textDone(): void {
    this.progress.textDone = true
  }

  /** Resolves with `promise` unless the request retires first. */
  within<T>(promise: Promise<T>): Promise<T> {
    const signal = this.controller.signal
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        // The work is already running; a retired request only stops listening to it.
        promise.catch(() => undefined)
        reject(GENERATED_INPUT_RETIRED)
        return
      }
      const retired = (): void => reject(GENERATED_INPUT_RETIRED)
      signal.addEventListener('abort', retired, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', retired)
          resolve(value)
        },
        (reason: unknown) => {
          signal.removeEventListener('abort', retired)
          reject(reason)
        }
      )
    })
  }

  private follow(signal: AbortSignal | undefined, applies: () => boolean): void {
    if (!signal) {
      return
    }
    const end = (): void => {
      if (applies()) {
        this.retire()
      }
    }
    if (signal.aborted) {
      end()
    } else {
      signal.addEventListener('abort', end, { once: true })
    }
  }
}

/** A queue turn owned from the moment it is granted and released exactly once, whether the grant
 *  arrives before or after the request retires. */
export function ownTurn(
  granting: Promise<() => void>,
  lifetime: GeneratedInputLifetime
): { granted: Promise<() => void>; release: () => void } {
  let grant: (() => void) | null = null
  let done = false
  const release = (): void => {
    if (grant && !done) {
      done = true
      grant()
    }
  }
  const granted = granting.then((value) => {
    grant = value
    if (lifetime.retired) {
      release()
    }
    return value
  })
  granted.catch(() => undefined)
  lifetime.signal.addEventListener('abort', () => queueMicrotask(release), { once: true })
  return { granted, release }
}

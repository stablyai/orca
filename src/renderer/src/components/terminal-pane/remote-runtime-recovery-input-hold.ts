import type { PtyInputSource } from './pty-input-source'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import {
  createPtyPreconnectInputBuffer,
  type AcceptedInputOptions,
  type PreconnectInputWriter,
  type PtyPreconnectInputBuffer
} from './pty-preconnect-input-buffer'

/** The remote terminal a held keystroke was typed into. */
export type RemoteRuntimeInputEndpoint = {
  handle: string
  incarnationId: string | null
}

// Why: release() always supplies an accepted-write path, so the hold requires what the buffer only accepts.
type HeldInputWriter = PreconnectInputWriter &
  Required<Pick<PreconnectInputWriter, 'sendInputAccepted'>>

// Why null: typing on a restored screen precedes the connect that names its terminal.
type HeldEndpoint = RemoteRuntimeInputEndpoint | null

type HeldInput = {
  endpoint: HeldEndpoint
  buffer: PtyPreconnectInputBuffer
  /** Typed before the pane bound a terminal; settles when the connect that expects it ends. */
  beforeBind: boolean
  /** A person's keys were held, not only terminal replies, so dropping them is worth telling. */
  typed: boolean
}

/** One connect's claim on pre-bind typing; identity decides which connect may settle it. */
export type RestoredInputExpectation = {
  readonly endpoint: HeldEndpoint
  /** A brand-new pane's first create: its pre-bind typing belongs to whatever terminal it makes. */
  readonly newTerminal?: true
}

export type RemoteRuntimeRecoveryInputHold = {
  isHolding: () => boolean
  hasPendingInput: () => boolean
  isHoldingBeforeBind: () => boolean
  enqueue: (
    endpoint: HeldEndpoint,
    data: string,
    inputKind: TerminalInputKind,
    source?: PtyInputSource
  ) => boolean
  enqueueAccepted: (
    endpoint: HeldEndpoint,
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions,
    source?: PtyInputSource
  ) => Promise<boolean>
  /** Binds pre-bind typing to the terminal a connect restores; null (a fresh create) drops it. */
  expect: (endpoint: HeldEndpoint) => RestoredInputExpectation
  /** Keeps a brand-new pane's pre-bind typing for the terminal its first create makes. */
  expectNewTerminal: () => RestoredInputExpectation
  /**
   * Ends the latest connect's expectation: without a bound terminal its typing is dropped. A
   * new-terminal expectation keeps it only when `createdEndpoint` names the terminal it made.
   */
  settleExpectation: (
    expectation: RestoredInputExpectation,
    bound: boolean,
    createdEndpoint?: RemoteRuntimeInputEndpoint | null
  ) => void
  /** Delivers held input to the endpoint it was typed into, or drops it if the pane rebound elsewhere. */
  release: (
    bound: RemoteRuntimeInputEndpoint,
    writer: HeldInputWriter
  ) => { done: Promise<void> } | undefined
  discard: () => void
  discardUnscoped: () => void
}

export function isSameRemoteRuntimeInputEndpoint(
  held: RemoteRuntimeInputEndpoint,
  bound: RemoteRuntimeInputEndpoint
): boolean {
  // Why: an incarnation learned only after the hold began is not evidence of a respawn.
  return (
    held.handle === bound.handle &&
    (held.incarnationId === null ||
      bound.incarnationId === null ||
      held.incarnationId === bound.incarnationId)
  )
}

/** Keeps keystrokes typed while a remote pane is binding or recovering, scoped to one endpoint. */
export function createRemoteRuntimeRecoveryInputHold(
  options: {
    holdBeforeFirstConnect?: boolean
    /** Keys typed before the pane bound a terminal were dropped for safety, unsent. */
    onTypingDiscardedBeforeBind?: () => void
  } = {}
): RemoteRuntimeRecoveryInputHold {
  const newHold = (endpoint: HeldEndpoint, beforeBind: boolean): HeldInput => ({
    endpoint,
    buffer: createPtyPreconnectInputBuffer([], { recoveryHold: true }),
    beforeBind,
    typed: false
  })
  let held: HeldInput | null = options.holdBeforeFirstConnect ? newHold(null, true) : null
  // Why: only the latest connect may settle pre-bind typing; a superseded one must not drop it.
  let latestExpectation: RestoredInputExpectation | null = null

  const discard = (): void => {
    const current = held
    held = null
    latestExpectation = null
    const droppedTyping =
      current?.beforeBind === true && current.typed && current.buffer.hasPendingInput()
    let failed = false
    let failure: unknown
    try {
      current?.buffer.clear()
    } catch (error) {
      failed = true
      failure = error
    }
    try {
      if (droppedTyping) {
        options.onTypingDiscardedBeforeBind?.()
      }
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
    if (failed) {
      throw failure
    }
  }

  const withdrawOrdinary = (
    current: HeldInput,
    endpoint: HeldEndpoint,
    beforeBind = false,
    ensureHold = false
  ): HeldInput | null => {
    const droppedTyping = current.beforeBind && current.typed && current.buffer.hasPendingInput()
    let replacement: HeldInput | null = null
    let failure: unknown
    try {
      current.buffer.discardUnscoped(() => {
        if (held !== current) {
          return
        }
        replacement = current.buffer.isBuffering()
          ? { endpoint, buffer: current.buffer, beforeBind, typed: false }
          : ensureHold
            ? newHold(endpoint, beforeBind)
            : null
        held = replacement
      })
    } catch (error) {
      failure = error
    }
    try {
      if (droppedTyping) {
        options.onTypingDiscardedBeforeBind?.()
      }
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) {
      throw failure
    }
    return held === replacement ? replacement : null
  }

  const matches = (endpoint: HeldEndpoint): boolean =>
    endpoint === null
      ? held?.beforeBind === true
      : held?.endpoint != null && isSameRemoteRuntimeInputEndpoint(held.endpoint, endpoint)

  const bufferFor = (
    endpoint: HeldEndpoint,
    inputKind: TerminalInputKind,
    source?: PtyInputSource
  ): PtyPreconnectInputBuffer | undefined => {
    if (held && !matches(endpoint)) {
      // Input typed at one shell must never run in its replacement (#10065).
      latestExpectation = null
      if (!withdrawOrdinary(held, endpoint, endpoint === null, true)) {
        return undefined
      }
    }
    if (!held?.buffer.isBuffering()) {
      held = newHold(endpoint, endpoint === null)
    }
    if (!source && inputKind === 'driving') {
      held.typed = true
    }
    return held.buffer
  }

  return {
    isHolding: () => held?.buffer.isBuffering() === true,
    hasPendingInput: () => held?.buffer.hasPendingInput() === true,
    isHoldingBeforeBind: () => held?.beforeBind === true && held.buffer.isBuffering(),
    enqueue: (endpoint, data, inputKind, source) =>
      bufferFor(endpoint, inputKind, source)?.enqueue(
        data,
        'ordinary',
        inputKind,
        undefined,
        source
      ) ?? false,
    enqueueAccepted: (endpoint, data, inputKind, acceptedOptions, source) =>
      bufferFor(endpoint, inputKind, source)?.enqueueAccepted(
        data,
        inputKind,
        undefined,
        acceptedOptions,
        source
      ) ?? Promise.resolve(false),
    expect(endpoint) {
      const expectation: RestoredInputExpectation = { endpoint }
      latestExpectation = endpoint ? expectation : null
      if (!endpoint) {
        if (held?.beforeBind) {
          withdrawOrdinary(held, null)
        }
        return expectation
      }
      if (held?.endpoint && !matches(endpoint)) {
        withdrawOrdinary(held, endpoint, true, true)
      }
      if (latestExpectation !== expectation) {
        return expectation
      }
      if (!held?.buffer.isBuffering()) {
        held = newHold(endpoint, true)
      }
      held.endpoint ??= endpoint
      held.beforeBind = true
      return expectation
    },
    expectNewTerminal() {
      const expectation: RestoredInputExpectation = { endpoint: null, newTerminal: true }
      latestExpectation = expectation
      if (held?.endpoint) {
        withdrawOrdinary(held, null, true, true)
      }
      if (latestExpectation !== expectation) {
        return expectation
      }
      if (!held?.buffer.isBuffering()) {
        held = newHold(null, true)
      }
      held.beforeBind = true
      return expectation
    },
    settleExpectation(expectation, bound, createdEndpoint) {
      if (expectation !== latestExpectation) {
        return
      }
      latestExpectation = null
      if (!held?.beforeBind) {
        return
      }
      if (!bound || (expectation.newTerminal && !createdEndpoint)) {
        withdrawOrdinary(held, held.endpoint)
        return
      }
      if (expectation.newTerminal) {
        held.endpoint = createdEndpoint ?? null
      }
      held.beforeBind = false
    },
    release(bound, writer) {
      let current = held
      if (!current) {
        return
      }
      if (!current.endpoint || !isSameRemoteRuntimeInputEndpoint(current.endpoint, bound)) {
        latestExpectation = null
        current = withdrawOrdinary(current, bound)
        if (!current) {
          return
        }
      }
      const releasing = current
      const done = releasing.buffer
        .flush({
          ...writer,
          isCurrent: () => held?.buffer === releasing.buffer && writer.isCurrent()
        })
        .catch(() => undefined)
        .finally(() => {
          if (held?.buffer === releasing.buffer && !releasing.buffer.isBuffering()) {
            held = null
          }
        })
      return { done }
    },
    discardUnscoped: () => {
      latestExpectation = null
      if (held) {
        withdrawOrdinary(held, null)
      }
    },
    discard
  }
}

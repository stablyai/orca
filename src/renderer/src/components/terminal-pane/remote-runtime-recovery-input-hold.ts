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
  enqueue: (endpoint: HeldEndpoint, data: string, inputKind: TerminalInputKind) => boolean
  enqueueAccepted: (
    endpoint: HeldEndpoint,
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions
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
    const droppedTyping =
      current?.beforeBind === true && current.typed && current.buffer.hasPendingInput()
    current?.buffer.clear()
    if (droppedTyping) {
      options.onTypingDiscardedBeforeBind?.()
    }
  }

  const matches = (endpoint: HeldEndpoint): boolean =>
    endpoint === null
      ? held?.beforeBind === true
      : held?.endpoint != null && isSameRemoteRuntimeInputEndpoint(held.endpoint, endpoint)

  const bufferFor = (
    endpoint: HeldEndpoint,
    inputKind: TerminalInputKind
  ): PtyPreconnectInputBuffer => {
    if (held && !matches(endpoint)) {
      // Why: input typed at one shell must never run in its replacement (#10065).
      discard()
    }
    if (!held?.buffer.isBuffering()) {
      // Why: a drained buffer refuses input; its release bookkeeping may still be settling.
      held = newHold(endpoint, endpoint === null)
    }
    if (inputKind === 'driving') {
      held.typed = true
    }
    return held.buffer
  }

  return {
    isHolding: () => held?.buffer.isBuffering() === true,
    hasPendingInput: () => held?.buffer.hasPendingInput() === true,
    isHoldingBeforeBind: () => held?.beforeBind === true && held.buffer.isBuffering(),
    enqueue: (endpoint, data, inputKind) =>
      bufferFor(endpoint, inputKind).enqueue(data, 'ordinary', inputKind),
    enqueueAccepted: (endpoint, data, inputKind, acceptedOptions) =>
      bufferFor(endpoint, inputKind).enqueueAccepted(data, inputKind, undefined, acceptedOptions),
    expect(endpoint) {
      const expectation: RestoredInputExpectation = { endpoint }
      latestExpectation = endpoint ? expectation : null
      if (!endpoint) {
        if (held?.beforeBind) {
          discard()
        }
        return expectation
      }
      let expected = held
      if (!expected?.buffer.isBuffering() || (expected.endpoint && !matches(endpoint))) {
        discard()
        expected = newHold(endpoint, true)
        held = expected
      }
      expected.endpoint ??= endpoint
      expected.beforeBind = true
      return expectation
    },
    expectNewTerminal() {
      const expectation: RestoredInputExpectation = { endpoint: null, newTerminal: true }
      latestExpectation = expectation
      if (!held?.buffer.isBuffering() || held.endpoint) {
        discard()
        held = newHold(null, true)
      }
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
        discard()
        return
      }
      if (expectation.newTerminal) {
        held.endpoint = createdEndpoint ?? null
      }
      held.beforeBind = false
    },
    release(bound, writer) {
      const current = held
      if (!current) {
        return
      }
      if (!current.endpoint || !isSameRemoteRuntimeInputEndpoint(current.endpoint, bound)) {
        discard()
        if (current.beforeBind) {
          // Why: the restored screen still shows the original terminal until its connect settles.
          held = newHold(current.endpoint, true)
        }
        return
      }
      const done = current.buffer
        .flush({
          ...writer,
          isCurrent: () => held === current && writer.isCurrent()
        })
        .catch(() => undefined)
        .finally(() => {
          if (held === current && !current.buffer.isBuffering()) {
            held = null
          }
        })
      return { done }
    },
    discard
  }
}

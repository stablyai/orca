import type { TuiAgent } from './tui-agent'
import { admitsGeneratedInput } from './generated-agent-input-admission'
import {
  GENERATED_AGENT_INPUT_QUIET_MS,
  type GeneratedInputIntent
} from './generated-agent-input-readiness'
import { prepareTypedText, type PreparedTypedText } from './agent-input-dialog'
import { ENTER_COMMIT_MARGIN_MS, generatedInputSequence } from './generated-input-sequence'
import {
  GeneratedInputObservation,
  type GeneratedInputObservationFeed
} from './generated-input-observation'
import {
  admissionScreen,
  admitsWithoutGrid,
  gridShowsReadyComposer,
  type GeneratedInputEvidence
} from './generated-input-readiness-evaluation'
import {
  GENERATED_INPUT_RETIRED as RETIRED,
  GENERATED_INPUT_TURN_BUDGET_MS,
  ownTurn,
  raceUntil,
  type GeneratedInputLifetime,
  type GeneratedInputOutcomeKind
} from './generated-input-lifetime'

/** Before each frame: `admit` rechecks the input region and the deadline; `dispatching` is called
 *  synchronously as the bytes are handed over and told whether the terminal took them ('unknown'
 *  when the answer was lost, which stays unconfirmed). */
export type GeneratedInputFrameGate = {
  admit: (typedText?: string) => Promise<boolean>
  dispatching: () => (taken: boolean | 'unknown') => void
}

/** Where one generated write's facts come from and where its bytes go. A source never decides
 *  readiness or admission; it reports evidence (including that it has none) and performs I/O. */
export type GeneratedInputSource = GeneratedInputObservationFeed & {
  /** This operation's turn in the terminal's input queue; on abort it rejects and gives up its
   *  place without running anything. Resolves the turn's release. */
  acquire: (signal: AbortSignal) => Promise<() => void>
  /** After the turn opens: true when the source now targets a different terminal than it
   *  observed (a default target re-resolved before any byte); its evidence starts over. */
  takeRetarget?: () => boolean
  /** The agent the current target runs, when the source resolves it; read again on a retarget. */
  readonly agent?: TuiAgent | null
  read: (signal: AbortSignal) => Promise<GeneratedInputEvidence>
  /** Writes the text as one frame or ordered chunks, each through the gate; false when a frame
   *  was refused or not taken. */
  writeText: (gate: GeneratedInputFrameGate) => Promise<boolean>
  /** The text frame itself carries Enter (agents that lose a separate Enter). */
  textCarriesEnter?: boolean
  /** Time the settle wait and Enter need after the text, reserved before the text is written. */
  enterReserveMs: number
  /** Waits for the text to settle before Enter. */
  settle: (signal: AbortSignal) => Promise<void>
  writeEnter: (gate: GeneratedInputFrameGate) => Promise<boolean>
  /** Agent-specific Enter retries after a committed Enter; they never change the outcome. */
  retry?: (gate: GeneratedInputFrameGate, signal: AbortSignal) => Promise<void>
}

export type GeneratedInputOperationRequest = {
  agent: TuiAgent | null
  /** The agent the caller authorized this request for, when that differs from the target's
   *  resolved agent; `requireConsumer` checks it, never the framing agent. */
  consumer?: TuiAgent | null
  submit: boolean
  intent: GeneratedInputIntent
  /** The request's one lifetime, created where it was accepted. */
  lifetime: GeneratedInputLifetime
  /** A launch's own readiness wait already saw this composer; every veto still applies. */
  observedReady?: boolean
  /** Every frame needs the expected consumer (or a wrapper with a child) in front, not just any
   *  non-shell process; unknown still passes. */
  requireConsumer?: boolean
  /** Runs after a written outcome, still in this operation's queue turn (turn observation). */
  afterWrite?: () => Promise<void>
}

export type GeneratedInputOperationOutcome = GeneratedInputOutcomeKind

export type GeneratedInputOperationResult = {
  outcome: GeneratedInputOperationOutcome
  /** What a source threw, for callers whose contract names the cause. */
  error?: unknown
  /** The queue turn, retries and afterWrite have ended. */
  finished: Promise<void>
}

const CHECK_INTERVAL_MS = 150

/** One generated write, from observation through its outcome, for either source. The outcome
 *  settles at the deadline or abort whatever is pending; from then on no frame is admitted. */
export function runGeneratedInputOperation(
  source: GeneratedInputSource,
  request: GeneratedInputOperationRequest
): Promise<GeneratedInputOperationResult> {
  const { submit, lifetime } = request
  let running = request.intent === 'running'
  // Every target-dependent fact, derived again once the queue turn selects its final target.
  let seq = generatedInputSequence(request.agent, submit, source)
  const consumer = (): TuiAgent | null =>
    request.consumer !== undefined ? request.consumer : seq.agent
  const acceptedAt = Date.now()
  let wake: (() => void) | null = null
  // When the no-grid lane's quiet comes due, so the check runs then rather than a beat later.
  let quietDueAt: number | null = null
  let observation = new GeneratedInputObservation(seq.readySignal, () => wake?.())
  let error: unknown
  // The typed text is the same for every frame: normalized once per operation.
  let typedRaw: string | undefined
  let typedPrepared: PreparedTypedText | undefined
  const typed = (text?: string): PreparedTypedText | undefined => {
    if (text !== undefined && text !== typedRaw) {
      typedRaw = text
      typedPrepared = prepareTypedText(text)
    }
    return text === undefined ? undefined : typedPrepared
  }
  const within = <T>(promise: Promise<T>): Promise<T> => lifetime.within(promise)
  const nextCheck = (): Promise<void> =>
    within(
      new Promise<void>((resolve) => {
        const now = Date.now()
        const due = [observation.graceAt, quietDueAt].filter(
          (at): at is number => at !== null && at > now
        )
        const delay = Math.min(CHECK_INTERVAL_MS, ...due.map((at) => at - now))
        const timer = setTimeout(done, delay)
        function done(): void {
          clearTimeout(timer)
          wake = null
          resolve()
        }
        wake = done
      })
    )
  const read = async () => {
    const read = await within(source.read(lifetime.signal))
    // A model still catching up is no blocking evidence for an agent already reading input; what
    // was streamed meanwhile still is.
    const evidence: GeneratedInputEvidence =
      running && read.screen === null ? { ...read, screen: 'unknown' } : read
    // Every lane of current evidence is judged: a dialog the source's read returns vetoes even
    // when this operation's own stream holds older, dialog-free text.
    const tail = [observation.tail, read.tail ?? ''].filter((lane) => lane.trim() !== '').join('\n')
    return { evidence, tail, screen: admissionScreen(evidence, tail) }
  }
  /** Quiet the no-grid lane needs: a normal quiet window, short enough that a check (one interval
   *  early at worst) still finds a legal text start before the last one the Enter reserve allows. */
  const compatibilityQuietMs = (): number =>
    lifetime.deadline === null
      ? GENERATED_AGENT_INPUT_QUIET_MS
      : Math.min(
          GENERATED_AGENT_INPUT_QUIET_MS,
          Math.max(0, lifetime.deadline - seq.enterReserveMs - CHECK_INTERVAL_MS - acceptedAt)
        )

  /** Startup proves the agent reads input; running only waits out blocking evidence. */
  const admitted = async (): Promise<boolean> => {
    let refusedAt = -1
    for (;;) {
      const observed = observation.sequence
      const { evidence, tail, screen } = await read()
      const quietMs = Date.now() - observation.lastOutput
      let marker = running || request.observedReady === true || observation.signalled()
      // Current evidence (a ready grid, or an older host's no-grid lane) is re-read each check;
      // the no-grid lane needs the expected consumer (or an unknown one) in front.
      const { agent, readySignal } = seq
      const requiredQuietMs = compatibilityQuietMs()
      quietDueAt = observation.lastOutput + requiredQuietMs
      const noGrid =
        !marker && admitsWithoutGrid(evidence, tail, agent, readySignal, quietMs, requiredQuietMs)
      const current =
        noGrid || (!marker && gridShowsReadyComposer(evidence, agent, readySignal, quietMs))
      marker ||= current
      const quiet =
        !marker &&
        seq.permitsQuiet &&
        (observation.quietArmed || evidence.bracketedPaste === true) &&
        quietMs >= GENERATED_AGENT_INPUT_QUIET_MS
      // A startup signal refused once is asked again only after the agent paints something new.
      const askAgain = running || current || refusedAt !== observed
      if ((marker || quiet) && askAgain) {
        const accepted = admitsGeneratedInput({
          agent,
          screen,
          process: evidence.process,
          quiet: (quiet && !marker) || noGrid || request.requireConsumer === true,
          ...(request.requireConsumer ? { consumer: consumer() } : {})
        })
        // Output during the read voids quiet; positive evidence survives a busy footer.
        if (accepted && (marker || observed === observation.sequence)) {
          return true
        }
        if (!accepted) {
          refusedAt = observed
        }
      }
      if (observed !== observation.sequence) {
        continue
      }
      await nextCheck()
    }
  }

  const gate = (frame: 'text' | 'enter'): GeneratedInputFrameGate => ({
    admit: async (typedText) => {
      // Text is refused when the budget left cannot also hold its settle wait and Enter.
      if (
        lifetime.retired ||
        (frame === 'text' &&
          (lifetime.deadline === null || Date.now() + seq.enterReserveMs >= lifetime.deadline))
      ) {
        return false
      }
      const { evidence, screen } = await read()
      return (
        !lifetime.retired &&
        admitsGeneratedInput({
          agent: seq.agent,
          screen,
          process: evidence.process,
          quiet: request.requireConsumer === true,
          ...(request.requireConsumer ? { consumer: consumer() } : {}),
          typedText: typed(typedText)
        })
      )
    },
    // Whether this frame is the Enter comes from the sequence's selected target.
    dispatching: () => lifetime.dispatching(frame === 'enter' || seq.carriesEnter)
  })
  const textGate = gate('text')
  const enterGate = gate('enter')

  const body = async (): Promise<void> => {
    // The turn is taken in call order and owned from its grant, whatever happens after.
    const turn = ownTurn(source.acquire(lifetime.signal), lifetime)
    try {
      // Observation starts with the operation, before its queue turn, and lasts until it ends.
      await within(observation.start(source)).catch((reason: unknown) => {
        if (reason === RETIRED) {
          throw reason
        }
      })
      await within(turn.granted)
      // A request with no caller deadline gets its wait-through-dialog budget from here.
      lifetime.arm(Date.now() + GENERATED_INPUT_TURN_BUDGET_MS)
      if (source.takeRetarget?.()) {
        // A replacement terminal is a fresh start: its own agent, rules, framing and evidence,
        // proved like a launch.
        seq = generatedInputSequence(
          source.agent !== undefined ? source.agent : request.agent,
          submit,
          source
        )
        observation.close()
        observation = new GeneratedInputObservation(seq.readySignal, () => wake?.())
        await within(observation.start(source)).catch(() => undefined)
        running = false
      }
      if (!(await admitted()) || !(await within(source.writeText(textGate)))) {
        return lifetime.settle()
      }
      lifetime.textDone()
      if (submit && !seq.carriesEnter) {
        await within(
          raceUntil(
            source.settle(lifetime.signal),
            (lifetime.deadline ?? 0) - ENTER_COMMIT_MARGIN_MS,
            lifetime.signal
          )
        )
        await within(source.writeEnter(enterGate))
      }
      // The definite outcome does not wait for optional retries or turn observation.
      lifetime.settle()
      const settled = await lifetime.outcome
      if (settled === 'delivered' && source.retry) {
        await within(source.retry(enterGate, lifetime.signal)).catch(() => undefined)
      }
      if (settled === 'delivered' || settled === 'staged') {
        await request.afterWrite?.()
      }
    } catch (reason) {
      if (reason !== RETIRED) {
        error = reason
      }
      lifetime.settle()
    } finally {
      lifetime.retire()
      observation.close()
      turn.release()
    }
  }
  const finished = body()
  return lifetime.outcome.then((settled) => ({ outcome: settled, error, finished }))
}

import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { resolvePasteReadySignal } from './draft-paste-ready-scanner'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from './agent-prompt-injection'
import { admitsGeneratedInput } from './generated-agent-input-admission'
import {
  GENERATED_AGENT_INPUT_QUIET_MS,
  signalAllowsCompatibilityEvidence,
  type GeneratedInputIntent
} from './generated-agent-input-readiness'
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

// The checks before Enter end early enough for Enter's own check and write to land in the budget.
const ENTER_COMMIT_MARGIN_MS = 50
const CHECK_INTERVAL_MS = 150

/** One generated write, from observation through its outcome, for either source. The outcome
 *  settles at the deadline or abort whatever is pending; from then on no frame is admitted. */
export function runGeneratedInputOperation(
  source: GeneratedInputSource,
  request: GeneratedInputOperationRequest
): Promise<GeneratedInputOperationResult> {
  const { agent, submit, lifetime } = request
  let running = request.intent === 'running'
  const readySignal = resolvePasteReadySignal(agent ? TUI_AGENT_CONFIG[agent] : null, submit)
  const permitsQuiet = signalAllowsCompatibilityEvidence(readySignal)
  const acceptedAt = Date.now()
  const enterReserveMs =
    submit && !source.textCarriesEnter
      ? source.enterReserveMs + AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + ENTER_COMMIT_MARGIN_MS
      : 0
  let wake: (() => void) | null = null
  let observation = new GeneratedInputObservation(readySignal, () => wake?.())
  let error: unknown
  const within = <T>(promise: Promise<T>): Promise<T> => lifetime.within(promise)
  const nextCheck = (): Promise<void> =>
    within(
      new Promise<void>((resolve) => {
        const grace = observation.graceAt
        const delay =
          grace !== null && grace > Date.now()
            ? Math.min(CHECK_INTERVAL_MS, grace - Date.now())
            : CHECK_INTERVAL_MS
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
    const tail = observation.tail || read.tail || ''
    return { evidence, tail, screen: admissionScreen(evidence, tail) }
  }
  /** Quiet the no-grid lane needs: a normal quiet window, never more than the budget allows. */
  const compatibilityQuietMs = (): number =>
    lifetime.deadline === null
      ? GENERATED_AGENT_INPUT_QUIET_MS
      : Math.min(
          GENERATED_AGENT_INPUT_QUIET_MS,
          Math.max(0, lifetime.deadline - acceptedAt - enterReserveMs)
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
      const noGrid =
        !marker &&
        admitsWithoutGrid(evidence, tail, agent, readySignal, quietMs, compatibilityQuietMs())
      const current =
        noGrid || (!marker && gridShowsReadyComposer(evidence, agent, readySignal, quietMs))
      marker ||= current
      const quiet =
        !marker &&
        permitsQuiet &&
        (observation.quietArmed || evidence.bracketedPaste === true) &&
        quietMs >= GENERATED_AGENT_INPUT_QUIET_MS
      // A startup signal refused once is asked again only after the agent paints something new.
      const askAgain = running || current || refusedAt !== observed
      if ((marker || quiet) && askAgain) {
        const accepted = admitsGeneratedInput({
          agent,
          screen,
          process: evidence.process,
          quiet: (quiet && !marker) || noGrid || request.requireConsumer === true
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

  const gate = (enter: boolean): GeneratedInputFrameGate => ({
    admit: async (typedText) => {
      if (lifetime.retired) {
        return false
      }
      const { evidence, screen } = await read()
      return (
        !lifetime.retired &&
        admitsGeneratedInput({
          agent,
          screen,
          process: evidence.process,
          quiet: request.requireConsumer === true,
          typedText
        })
      )
    },
    dispatching: () => lifetime.dispatching(enter)
  })
  const textGate = gate(source.textCarriesEnter === true && submit)
  const enterGate = gate(true)
  // Text is refused when the budget left cannot also hold its settle wait and Enter.
  const textAdmit = textGate.admit
  textGate.admit = async (typedText) =>
    lifetime.deadline !== null &&
    Date.now() + enterReserveMs < lifetime.deadline &&
    (await textAdmit(typedText))

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
        // A replacement terminal is a fresh start: its own evidence, proved like a launch.
        observation.close()
        observation = new GeneratedInputObservation(readySignal, () => wake?.())
        await within(observation.start(source)).catch(() => undefined)
        running = false
      }
      if (!(await admitted()) || !(await within(source.writeText(textGate)))) {
        return lifetime.settle()
      }
      lifetime.textDone()
      if (submit && !source.textCarriesEnter) {
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

/** Resolves when `promise` does or at `until`, whichever comes first. */
function raceUntil(promise: Promise<unknown>, until: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, until - Date.now()))
    const stop = (): void => clearTimeout(timer)
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      () => {
        stop()
        resolve()
      },
      (reason: unknown) => {
        stop()
        reject(reason)
      }
    )
  })
}

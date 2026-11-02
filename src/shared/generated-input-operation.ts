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
  GENERATED_INPUT_BLIND_POLICY,
  gridShowsReadyComposer,
  isBlindEvidence,
  type GeneratedInputEvidence
} from './generated-input-readiness-evaluation'

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
  /** Absolute; fixed when the operation was accepted, so queueing spends it. */
  deadline: number
  signal?: AbortSignal
  /** A launch's own readiness wait already saw this composer; every veto still applies. */
  observedReady?: boolean
  /** Runs after a written outcome, still in this operation's queue turn (turn observation). */
  afterWrite?: () => Promise<void>
}

export type GeneratedInputOperationOutcome = 'delivered' | 'staged' | 'unconfirmed' | 'not-sent'

export type GeneratedInputOperationResult = {
  outcome: GeneratedInputOperationOutcome
  /** What a source threw, for callers whose contract names the cause. */
  error?: unknown
  /** The queue turn, retries and afterWrite have ended. */
  finished: Promise<void>
}

const RETIRED = Symbol('generated-input-retired')
// The checks before Enter end early enough for Enter's own check and write to land in the budget.
const ENTER_COMMIT_MARGIN_MS = 50
const CHECK_INTERVAL_MS = 150

/** One generated write, from observation through its outcome, for either source. The outcome
 *  settles at the deadline or abort whatever is pending; from then on no frame is admitted. */
export function runGeneratedInputOperation(
  source: GeneratedInputSource,
  request: GeneratedInputOperationRequest
): Promise<GeneratedInputOperationResult> {
  const { agent, submit, deadline } = request
  const running = request.intent === 'running'
  const readySignal = resolvePasteReadySignal(agent ? TUI_AGENT_CONFIG[agent] : null, submit)
  const permitsQuiet = signalAllowsCompatibilityEvidence(readySignal)
  const life = new AbortController()
  let wake: (() => void) | null = null
  const observation = new GeneratedInputObservation(readySignal, () => wake?.())
  const progress = { pending: 0, accepted: 0, textDone: false, enter: false }
  let error: unknown

  const settleFromProgress = (): GeneratedInputOperationOutcome => {
    if (progress.enter) {
      return 'delivered'
    }
    if (progress.textDone && !submit) {
      return 'staged'
    }
    return progress.accepted > 0 || progress.pending > 0 ? 'unconfirmed' : 'not-sent'
  }
  const within = <T>(promise: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (life.signal.aborted) {
        // The work is already running; a retired operation only stops listening to it.
        promise.catch(() => undefined)
        reject(RETIRED)
        return
      }
      const retire = (): void => reject(RETIRED)
      life.signal.addEventListener('abort', retire, { once: true })
      promise.then(
        (value) => {
          life.signal.removeEventListener('abort', retire)
          resolve(value)
        },
        (reason: unknown) => {
          life.signal.removeEventListener('abort', retire)
          reject(reason)
        }
      )
    })
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
    const read = await within(source.read(life.signal))
    // A model still catching up is no blocking evidence for an agent already reading input; what
    // was streamed meanwhile still is.
    const evidence: GeneratedInputEvidence =
      running && read.screen === null ? { ...read, screen: 'unknown' } : read
    const tail = observation.tail
    return { evidence, tail, screen: admissionScreen(evidence, tail) }
  }

  /** Startup proves the agent reads input; running only waits out blocking evidence. */
  const admitted = async (): Promise<boolean> => {
    let refusedAt = -1
    for (;;) {
      const observed = observation.sequence
      const { evidence, tail, screen } = await read()
      const quietMs = Date.now() - observation.lastOutput
      let marker = running || request.observedReady === true || observation.signalled()
      let current = false
      if (!marker) {
        current =
          gridShowsReadyComposer(evidence, agent, readySignal, quietMs) ||
          (GENERATED_INPUT_BLIND_POLICY === 'deliver' && isBlindEvidence(evidence, tail))
        marker = current
      }
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
          quiet: quiet && !marker
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
      if (life.signal.aborted) {
        return false
      }
      const { evidence, screen } = await read()
      return (
        !life.signal.aborted &&
        admitsGeneratedInput({ agent, screen, process: evidence.process, quiet: false, typedText })
      )
    },
    dispatching: () => {
      if (life.signal.aborted) {
        throw RETIRED
      }
      progress.pending += 1
      return (taken) => {
        if (taken === 'unknown') {
          return
        }
        progress.pending -= 1
        if (taken) {
          progress.accepted += 1
          progress.enter ||= enter
        }
      }
    }
  })
  const textGate = gate(source.textCarriesEnter === true && submit)
  const enterGate = gate(true)
  // Text is refused when the budget left cannot also hold its settle wait and Enter.
  const textAdmit = textGate.admit
  textGate.admit = async (typedText) => {
    const reserve =
      submit && !source.textCarriesEnter
        ? source.enterReserveMs + AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS + ENTER_COMMIT_MARGIN_MS
        : 0
    return Date.now() + reserve < deadline && (await textAdmit(typedText))
  }

  let resolveOutcome!: (outcome: GeneratedInputOperationOutcome) => void
  const outcome = new Promise<GeneratedInputOperationOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  const retire = (): void => {
    life.abort()
    // An abort raised inside a write is read after the writer records whether that write was taken.
    queueMicrotask(() => resolveOutcome(settleFromProgress()))
  }
  const timer = setTimeout(retire, Math.max(0, deadline - Date.now()))
  if (request.signal?.aborted) {
    retire()
  }
  request.signal?.addEventListener('abort', retire, { once: true })

  const body = async (): Promise<void> => {
    let release: (() => void) | undefined
    try {
      // Observation starts before the queue turn and lasts until the operation ends.
      await within(observation.start(source)).catch((reason: unknown) => {
        if (reason === RETIRED) {
          throw reason
        }
      })
      release = await within(source.acquire(life.signal))
      if (!(await admitted())) {
        return resolveOutcome(settleFromProgress())
      }
      if (!(await within(source.writeText(textGate)))) {
        return resolveOutcome(settleFromProgress())
      }
      progress.textDone = true
      if (!submit || source.textCarriesEnter) {
        resolveOutcome(settleFromProgress())
      } else {
        await within(
          raceUntil(source.settle(life.signal), deadline - ENTER_COMMIT_MARGIN_MS, life.signal)
        )
        const entered = await within(source.writeEnter(enterGate))
        resolveOutcome(settleFromProgress())
        if (!entered) {
          return
        }
      }
      if (progress.enter && source.retry) {
        await within(source.retry(enterGate, life.signal)).catch(() => undefined)
      }
      await request.afterWrite?.()
    } catch (reason) {
      if (reason !== RETIRED) {
        error = reason
      }
      resolveOutcome(settleFromProgress())
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', retire)
      life.abort()
      observation.close()
      release?.()
    }
  }
  const finished = body()
  return outcome.then((settled) => ({ outcome: settled, error, finished }))
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

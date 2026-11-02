import { GeneratedInputObservation } from './generated-input-observation'
import type { DraftPasteReadySignal } from './tui-agent-config'

export const GENERATED_AGENT_INPUT_TIMEOUT_MS = 60_000
export const GENERATED_AGENT_INPUT_QUIET_MS = 1500

export type GeneratedAgentInputHost = {
  subscribe: (observe: (data: string) => void) => (() => void) | Promise<() => void>
  replay?: () => string | undefined
  /** Current positive evidence; `quietMs` is how long output has been silent, for idle rules
   *  that settle only after quiet. */
  composerReady?: (quietMs: number) => boolean | Promise<boolean>
  /** The terminal's current bracketed-paste mode, when the host's model knows it. */
  bracketedPaste?: () => boolean
  accept: (quiet: boolean) => boolean | Promise<boolean>
}

/** Agents whose composer paints before it takes input prove readiness only with their own marker;
 *  quiet or a painted composer glyph is no evidence for them. */
export function signalAllowsCompatibilityEvidence(signal: DraftPasteReadySignal): boolean {
  return (
    signal !== 'codex-composer-prompt' &&
    signal !== 'opencode-agent-row' &&
    signal !== 'render-cursor-after-bracketed-paste'
  )
}

/** startup: the agent was just launched and must prove it reads input. running: it already does,
 *  so only blocking evidence refuses, as a direct send would have been written. */
export type GeneratedInputIntent = 'startup' | 'running'

/** Observation-only readiness for callers that do not write (the launch-composer watch, held keys'
 *  pane timing): the same observation the generated-input operation keeps, read by their own
 *  `composerReady`/`accept` facts. Compatibility quiet is live evidence, never a deadline's
 *  permission. */
export function waitForGeneratedAgentInput(
  host: GeneratedAgentInputHost,
  signal: DraftPasteReadySignal,
  options: {
    timeoutMs?: number
    requireComposerMarker?: boolean
    signal?: AbortSignal
    intent?: GeneratedInputIntent
  } = {}
): Promise<boolean> {
  const running = options.intent === 'running'
  const deadline = Date.now() + (options.timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS)
  const permitsQuiet = !options.requireComposerMarker && signalAllowsCompatibilityEvidence(signal)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let checking = false
    let refusedAtSequence = -1
    const observation = new GeneratedInputObservation(signal, () => {
      clearTimeout(timer)
      void check()
    })
    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      observation.close()
      options.signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => finish(false)
    const check = async (): Promise<void> => {
      if (settled || checking) {
        return
      }
      if (Date.now() >= deadline) {
        return finish(false)
      }
      checking = true
      const observedSequence = observation.sequence
      try {
        const signalled = observation.signalled()
        const quietMs = Date.now() - observation.lastOutput
        // Current-screen evidence is re-read each time; it is not a one-shot signal.
        const current = !signalled && (await host.composerReady?.(quietMs)) === true
        const marker = signalled || current
        const quiet =
          permitsQuiet &&
          (observation.quietArmed || host.bracketedPaste?.() === true) &&
          quietMs >= GENERATED_AGENT_INPUT_QUIET_MS
        const quietOnly = quiet && !marker && !running
        // A startup signal refused once is asked again only when the agent paints something new.
        const askAgain = running || current || refusedAtSequence !== observation.sequence
        if ((marker || quiet || running) && askAgain) {
          if (await host.accept(quietOnly)) {
            if (
              !settled &&
              (!quietOnly || observedSequence === observation.sequence) &&
              Date.now() < deadline
            ) {
              finish(true)
            }
          } else {
            refusedAtSequence = observedSequence
          }
        }
      } catch {
        // A failed observation is no evidence; retry within this budget.
      } finally {
        checking = false
        if (!settled && observedSequence !== observation.sequence) {
          void check()
        } else if (!settled) {
          const graceAt = observation.graceAt
          const graceDelay = graceAt !== null && graceAt > Date.now() ? graceAt - Date.now() : 150
          timer = setTimeout(() => void check(), Math.min(150, graceDelay))
        }
      }
    }
    if (options.signal?.aborted) {
      return finish(false)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    hardTimer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
    void observation
      .start({ observe: host.subscribe, replay: host.replay })
      .then(() => void check())
      .catch(() => finish(false))
  })
}

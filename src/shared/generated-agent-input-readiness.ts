import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './tui-agent-config'

export const GENERATED_AGENT_INPUT_TIMEOUT_MS = 60_000
export const GENERATED_AGENT_INPUT_QUIET_MS = 1500

export type GeneratedAgentInputHost = {
  subscribe: (observe: (data: string) => void) => (() => void) | Promise<() => void>
  replay?: () => string | undefined
  composerReady?: () => boolean | Promise<boolean>
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

/** Compatibility quiet is live evidence, never a deadline's permission to write. */
export function waitForGeneratedAgentInput(
  host: GeneratedAgentInputHost,
  signal: DraftPasteReadySignal,
  options: { timeoutMs?: number; requireComposerMarker?: boolean; signal?: AbortSignal } = {}
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS)
  const permitsQuiet = !options.requireComposerMarker && signalAllowsCompatibilityEvidence(signal)
  return new Promise((resolve) => {
    let scanner = createDraftPasteReadyScanner(signal)
    let lastOutput = Date.now()
    let handoffCarry = ''
    let sequence = 0
    let ready = false
    // Quiet counts only once the agent has enabled paste input, seen live or in the current mode.
    let quietArmed = false
    let graceAt: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let settled = false
    let checking = false
    let replaying = true
    const pending: string[] = []
    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      unsubscribe?.()
      options.signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = (): void => finish(false)
    const scan = (data: string): void => {
      const combined = handoffCarry + data
      handoffCarry = combined.slice(-7)
      // oxlint-disable-next-line no-control-regex -- PTY mode resets revoke stale readiness.
      const handoffs = [...combined.matchAll(/\x1b\[\?(?:2004|2031|1049)l/g)]
      const last = handoffs.at(-1)
      if (last) {
        scanner = createDraftPasteReadyScanner(signal)
        ready = false
        quietArmed = false
        graceAt = null
        data = combined.slice(last.index + last[0].length)
      }
      const result = scanner.observe(data)
      ready ||= result.ready
      quietArmed ||= result.armQuietTimer
      if (result.readyAfterMs === null) {
        graceAt = null
      } else if (result.readyAfterMs !== undefined) {
        graceAt ??= Date.now() + result.readyAfterMs
      }
    }
    const check = async (): Promise<void> => {
      if (settled || checking) {
        return
      }
      if (Date.now() >= deadline) {
        return finish(false)
      }
      checking = true
      const observedSequence = sequence
      try {
        const marker =
          ready ||
          (graceAt !== null && Date.now() >= graceAt) ||
          (await host.composerReady?.()) === true
        const quiet =
          permitsQuiet &&
          (quietArmed || host.bracketedPaste?.() === true) &&
          Date.now() - lastOutput >= GENERATED_AGENT_INPUT_QUIET_MS
        // Output during the read voids only quiet; a positive composer survives a busy footer, and
        // the writer rechecks the current screen before every byte.
        if ((marker || quiet) && (await host.accept(!marker))) {
          if (!settled && (marker || observedSequence === sequence) && Date.now() < deadline) {
            finish(true)
          }
        }
      } catch {
        // A failed observation is no evidence; retry within this operation's budget.
      } finally {
        checking = false
        if (!settled && observedSequence !== sequence) {
          void check()
        } else if (!settled) {
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
    let subscription: ReturnType<GeneratedAgentInputHost['subscribe']>
    try {
      subscription = host.subscribe((data) => {
        lastOutput = Date.now()
        sequence += 1
        if (replaying) {
          pending.push(data)
        } else {
          scan(data)
          clearTimeout(timer)
          void check()
        }
      })
    } catch {
      return finish(false)
    }
    void Promise.resolve(subscription)
      .then((dispose) => {
        if (settled) {
          return dispose()
        }
        unsubscribe = dispose
        lastOutput = Date.now()
        const replay = host.replay?.()
        if (replay) {
          scan(replay)
        }
        for (const data of pending) {
          scan(data)
        }
        pending.length = 0
        replaying = false
        void check()
      })
      .catch(() => finish(false))
  })
}

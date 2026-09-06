// Why: a fixed sleep between pasting a prompt and sending Enter is a local-calibrated
// guess. `pasteTextIntoTerminalPane` resolves when the transport accepts the write, not
// when the agent has rendered it, so on a remote runtime the margin shrinks by the round
// trip and can be exceeded silently — the submit reports success and the prompt sits
// unsent in the agent's editor. Waiting on the agent's own redraw replaces the guess with
// evidence, which is both safer on a slow link and much faster locally.

/** Cadence of the evidence poll; small enough not to dominate the local path. */
const POLL_INTERVAL_MS = 20
/** Never send earlier than this, so one unrelated chunk cannot trigger an early Enter. */
const MIN_WAIT_MS = 80
/** Quiet period after the last parsed write, so a multi-chunk redraw finishes first. */
const REDRAW_SETTLE_MS = 60
/** A redraw that keeps producing output must not hold the submit open forever. */
const REDRAW_SETTLE_CAP_MS = 250
/** Hard ceiling when no redraw ever arrives; bounds the UI rather than hanging it. */
const DELIVERY_EVIDENCE_TIMEOUT_MS = 2_000

/** Minimal shape of the xterm terminal this wait needs. */
export type RichInputDeliveryTerminal = {
  onWriteParsed?: (listener: () => void) => { dispose: () => void }
}

export type RichInputDeliveryWaitArgs = {
  terminal: RichInputDeliveryTerminal | undefined
  /** Fallback wait used when the xterm build exposes no parse signal. */
  fallbackDelayMs: number
  delay: (milliseconds: number) => Promise<void>
  now?: () => number
}

export type RichInputDeliveryWaitResult = {
  /** False when Enter was sent without ever seeing the agent redraw. */
  confirmed: boolean
}

/** Resolves once the agent's redraw has settled, or on a bounded timeout. */
export async function waitForRichInputPasteDelivery({
  terminal,
  fallbackDelayMs,
  delay,
  now = () => performance.now()
}: RichInputDeliveryWaitArgs): Promise<RichInputDeliveryWaitResult> {
  // Why: some xterm builds lack onWriteParsed (see terminal-linkifier-hover-reset-on-write).
  // Without a parse signal there is no evidence to wait on, so keep the previous behavior.
  if (typeof terminal?.onWriteParsed !== 'function') {
    await delay(fallbackDelayMs)
    return { confirmed: false }
  }

  let firstWriteAt: number | null = null
  let lastWriteAt: number | null = null
  const subscription = terminal.onWriteParsed(() => {
    const at = now()
    firstWriteAt ??= at
    lastWriteAt = at
  })

  try {
    const startedAt = now()
    for (;;) {
      await delay(POLL_INTERVAL_MS)
      const elapsed = now() - startedAt
      if (firstWriteAt === null || lastWriteAt === null) {
        if (elapsed >= DELIVERY_EVIDENCE_TIMEOUT_MS) {
          return { confirmed: false }
        }
        continue
      }
      if (elapsed < MIN_WAIT_MS) {
        continue
      }
      const settled = now() - lastWriteAt >= REDRAW_SETTLE_MS
      const cappedOut = now() - firstWriteAt >= REDRAW_SETTLE_CAP_MS
      if (settled || cappedOut) {
        return { confirmed: true }
      }
    }
  } finally {
    subscription.dispose()
  }
}

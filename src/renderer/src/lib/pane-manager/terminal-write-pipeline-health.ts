// Why this module exists: a pane's xterm write pipeline can die while its PTY
// stays alive — a synchronous throw escaping an unguarded write callback wedges
// WriteBuffer (issue #2836), and write() on a disposed terminal silently drops
// its completion callback (verified against vendored xterm 6.1.0-beta.287). In
// both states every later write queues forever: output stops rendering,
// delivery ack credits leak, and the pane becomes a fossil the user can only
// cure by reloading the window. Detection here is probe-certified (mirroring
// replay-guard.ts): a stalled completion triggers an empty probe write; xterm
// parses in FIFO order, so a probe that also never completes proves the
// pipeline is dead rather than slow. Certification notifies a per-terminal
// handler (registered by the pane's PTY connection) that requests pane
// recovery — a remount that rebuilds the xterm and reattaches the live PTY.

type WriteTarget = {
  write(data: string, callback?: () => void): void
}

export type UndeliverableWriteReason = 'write-stalled' | 'replay-wedged'

type UndeliverableWriteHandler = (reason: UndeliverableWriteReason) => void

const handlersByTerminal = new WeakMap<object, UndeliverableWriteHandler>()
const certifiedDeadTerminals = new WeakSet<object>()

type StallWatch = {
  timer: ReturnType<typeof setTimeout>
  onCertifiedDead?: () => void
}

const stallWatchByTerminal = new WeakMap<object, StallWatch>()

export const WRITE_PIPELINE_STALL_CHECK_MS = 10_000

export function registerUndeliverableWriteHandler(
  terminal: object,
  handler: UndeliverableWriteHandler
): () => void {
  handlersByTerminal.set(terminal, handler)
  return () => {
    if (handlersByTerminal.get(terminal) === handler) {
      handlersByTerminal.delete(terminal)
    }
  }
}

/** One notification per terminal instance: recovery replaces the xterm, so a
 *  second notification for the same object is always a duplicate. */
export function notifyUndeliverableWrite(terminal: object, reason: UndeliverableWriteReason): void {
  if (certifiedDeadTerminals.has(terminal)) {
    return
  }
  certifiedDeadTerminals.add(terminal)
  try {
    handlersByTerminal.get(terminal)?.(reason)
  } catch {
    // Why: notify fires from timer and write-callback contexts where a throw
    // becomes an unhandled error; recovery is best-effort by contract (see
    // terminal-pane-recovery.ts).
  }
}

export function isTerminalWritePipelineCertifiedDead(terminal: object): boolean {
  return certifiedDeadTerminals.has(terminal)
}

/**
 * Arm (or keep armed) the stall watch for a terminal that just had a write
 * issued. Cleared by settleTerminalWriteStallWatch from the write-completion
 * callback. If the completion never arrives, an empty probe write certifies
 * dead-vs-slow exactly like replay-guard.ts: probe completes → pipeline is
 * alive (slow parse), re-arm and keep waiting; probe silent for another
 * interval → dead, notify.
 */
export function armTerminalWriteStallWatch(
  terminal: WriteTarget,
  options: { onCertifiedDead?: () => void; stallCheckMs?: number } = {}
): void {
  if (stallWatchByTerminal.has(terminal) || certifiedDeadTerminals.has(terminal)) {
    return
  }
  const stallCheckMs = options.stallCheckMs ?? WRITE_PIPELINE_STALL_CHECK_MS
  const watch: StallWatch = {
    onCertifiedDead: options.onCertifiedDead,
    timer: setTimeout(probeForStall, stallCheckMs)
  }
  const certifyDead = (): void => {
    // Why the ownership check: a settle (healthy completion) can land between
    // the probe write and this timeout; it removes the watch, and a stale
    // timer must not certify a live pipeline dead.
    if (stallWatchByTerminal.get(terminal) !== watch) {
      return
    }
    stallWatchByTerminal.delete(terminal)
    try {
      watch.onCertifiedDead?.()
    } catch {
      // Why: the discard callback bottoms out in window.api (ack credits); a
      // partial surface must not kill the timer unhandled — or suppress the
      // recovery notification below, which is the whole point of certifying.
    }
    notifyUndeliverableWrite(terminal, 'write-stalled')
  }
  function probeForStall(): void {
    if (stallWatchByTerminal.get(terminal) !== watch) {
      return
    }
    let probeParsed = false
    try {
      terminal.write('', () => {
        probeParsed = true
        // Why: a parsed probe proves the pipeline is alive — the stalled
        // completion was just slow. Disarm; the next write re-arms.
        const current = stallWatchByTerminal.get(terminal)
        if (current === watch) {
          clearTimeout(current.timer)
          stallWatchByTerminal.delete(terminal)
        }
      })
    } catch {
      certifyDead()
      return
    }
    watch.timer = setTimeout(() => {
      if (!probeParsed) {
        certifyDead()
      }
    }, stallCheckMs)
  }
  stallWatchByTerminal.set(terminal, watch)
}

/** Write completed normally — the pipeline is healthy; drop any pending watch. */
export function settleTerminalWriteStallWatch(terminal: object): void {
  const watch = stallWatchByTerminal.get(terminal)
  if (!watch) {
    return
  }
  clearTimeout(watch.timer)
  stallWatchByTerminal.delete(terminal)
}

export function _resetWritePipelineHealthForTests(terminal?: object): void {
  if (terminal) {
    const watch = stallWatchByTerminal.get(terminal)
    if (watch) {
      clearTimeout(watch.timer)
    }
    stallWatchByTerminal.delete(terminal)
    handlersByTerminal.delete(terminal)
    certifiedDeadTerminals.delete(terminal)
  }
}

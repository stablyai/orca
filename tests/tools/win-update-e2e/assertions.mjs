// Profile assertions and the final PASS/FAIL evidence table.
//
// Two profiles:
//   cold-restore — TODAY's behavior. The installer's path sweep kills the
//     in-dir daemon, so the old daemon PID must be DEAD, a fresh daemon must
//     exist, scrollback is cold-restored (best-effort), a new terminal is
//     interactive, and NO unexpected console/terminal windows appear.
//   survival — Phase 1 target. The daemon PID is UNCHANGED across the update,
//     the marker process is still alive, the pre-update session is still
//     interactive (echo + Ctrl+C), and NO unexpected windows appear.

const CONSOLE_HOST_PROCESSES = new Set([
  'powershell',
  'pwsh',
  'cmd',
  'conhost',
  'windowsterminal',
  'openconsole'
])

// The app's own windows are expected on relaunch and never count as a flash.
const APP_OWNER_PROCESSES = new Set(['orca', 'electron'])

/**
 * Split window-watch events into unexpected flashes vs benign. Unexpected =
 * (a) any window whose title contains the run's canary — a real flash of our
 * marker child, which must never get its own window — or (b) any new
 * console/terminal-host window that is not the app itself. Attribution is by
 * title + owner process only (never conhost command-line heuristics).
 */
export function classifyWindowEvents(events, { canary }) {
  const unexpected = []
  for (const event of events) {
    const title = typeof event.title === 'string' ? event.title : ''
    const owner = (event.processName ?? '').toLowerCase()
    const canaryHit = canary && title.includes(canary)
    const consoleHit = CONSOLE_HOST_PROCESSES.has(owner) && !APP_OWNER_PROCESSES.has(owner)
    if (canaryHit || consoleHit) {
      unexpected.push({ ...event, reason: canaryHit ? 'canary-title' : 'console-host' })
    }
  }
  return { unexpected }
}

function assertion(name, pass, expected, actual, detail = '') {
  return { name, pass, expected, actual, detail }
}

/** Build the ordered assertion list for the run's profile. */
export function buildAssertions(ctx) {
  const { unexpected } = classifyWindowEvents(ctx.watchEvents ?? [], { canary: ctx.canary })
  const windowAssertion = assertion(
    'zero unexpected console/terminal windows',
    unexpected.length === 0,
    '0 windows',
    `${unexpected.length} windows`,
    unexpected.map((u) => `${u.processName}:"${u.title}" (${u.reason})`).join('; ')
  )

  const common = [windowAssertion, daemonLogAssertion(ctx)]

  return ctx.profile === 'survival'
    ? [...survivalAssertions(ctx), ...common]
    : [...coldRestoreAssertions(ctx), ...common]
}

function survivalAssertions(ctx) {
  const samePid =
    ctx.preDaemonPid != null && ctx.preDaemonPid === ctx.postDaemonPid && ctx.postDaemonAlive
  return [
    assertion(
      'daemon PID unchanged across update',
      samePid,
      `pid ${ctx.preDaemonPid} still alive`,
      `post pid ${ctx.postDaemonPid} (alive: ${ctx.postDaemonAlive})`
    ),
    assertion(
      'marker process still alive',
      Boolean(ctx.markerAliveAfter),
      `marker pid ${ctx.markerPid} alive`,
      String(ctx.markerAliveAfter)
    ),
    assertion(
      'pre-update session streams (heartbeat advanced)',
      Boolean(ctx.heartbeatAdvancedAfterUpdate),
      'heartbeat mtime advanced post-update',
      String(ctx.heartbeatAdvancedAfterUpdate)
    ),
    assertion(
      'typed input echoes in pre-update session',
      Boolean(ctx.echoObserved),
      'echo sentinel file written',
      String(ctx.echoObserved)
    ),
    assertion(
      'Ctrl+C interrupts marker loop',
      Boolean(ctx.ctrlCInterrupted),
      'heartbeat stopped + post-interrupt sentinel written',
      String(ctx.ctrlCInterrupted)
    )
  ]
}

function coldRestoreAssertions(ctx) {
  const freshDaemon =
    ctx.postDaemonPid != null && ctx.postDaemonPid !== ctx.preDaemonPid && ctx.postDaemonAlive
  return [
    assertion(
      'old daemon PID is dead after update',
      ctx.preDaemonAliveAfter === false,
      `pid ${ctx.preDaemonPid} dead`,
      `alive: ${ctx.preDaemonAliveAfter}`
    ),
    assertion(
      'fresh daemon exists after relaunch',
      freshDaemon,
      'new daemon pid, alive',
      `post pid ${ctx.postDaemonPid} (alive: ${ctx.postDaemonAlive})`
    ),
    // Best-effort: WebGL renderer may hide buffer text from DOM scraping, so a
    // null result is reported as informational (pass=null), not a failure.
    assertion(
      'previous terminals show restored scrollback (best-effort)',
      ctx.scrollbackRestored === null ? null : ctx.scrollbackRestored,
      'prior output text present after restore',
      ctx.scrollbackRestored === null ? 'unknown (renderer opaque)' : String(ctx.scrollbackRestored)
    ),
    assertion(
      'new terminal is interactive (typed input echoes)',
      Boolean(ctx.echoObserved),
      'echo sentinel file written',
      String(ctx.echoObserved)
    ),
    assertion(
      'Ctrl+C kills a sleep loop in new terminal',
      Boolean(ctx.ctrlCInterrupted),
      'loop interrupted + post-interrupt sentinel written',
      String(ctx.ctrlCInterrupted)
    )
  ]
}

function daemonLogAssertion(ctx) {
  // The daemon has no file log today (stdio is suppressed in packaged forks).
  // Treat "no log present" as informational; when a log IS present (Phase 0
  // observability), assert it is free of ERROR lines.
  if (!ctx.daemonLog) {
    return assertion(
      'daemon log free of fatal records',
      null,
      'no fatal/invalid-token records',
      'no daemon log present (informational)'
    )
  }
  // Only genuinely-bad records count (fatal uncaught exceptions, invalid-token
  // hello rejections). Benign suppressed native-PTY exceptions are reported as
  // context but never affect pass/fail.
  const errorLines = ctx.daemonLog.errorLines ?? []
  const suppressed = ctx.daemonLog.suppressedCount ?? 0
  const suppressedNote = suppressed > 0 ? ` (${suppressed} benign suppressed, ignored)` : ''
  return assertion(
    'daemon log free of fatal records',
    errorLines.length === 0,
    'no fatal/invalid-token records',
    `${errorLines.length} fatal record(s)${suppressedNote}`,
    errorLines.slice(0, 3).join(' | ')
  )
}

/** True only if every non-informational assertion passed. */
export function allPassed(assertions) {
  return assertions.every((a) => a.pass === true || a.pass === null)
}

/** Render the assertion list as an aligned PASS/FAIL/INFO table. `label` names
 *  the harness in the header (shared with the crash-survival harness). */
export function renderTable(assertions, label = 'win-update-e2e') {
  const symbol = (pass) => (pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO')
  const nameWidth = Math.max(...assertions.map((a) => a.name.length), 10)
  const lines = assertions.map((a) => {
    const detail = a.detail ? `  — ${a.detail}` : ''
    return `  [${symbol(a.pass)}] ${a.name.padEnd(nameWidth)}  expected: ${a.expected}; actual: ${a.actual}${detail}`
  })
  const failed = assertions.filter((a) => a.pass === false).length
  const header = `\n===== ${label} assertions (${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}) =====`
  return [header, ...lines, ''].join('\n')
}

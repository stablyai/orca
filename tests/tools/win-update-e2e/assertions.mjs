// Update profiles: cold-restore requires old-daemon death/new daemon, best-effort scrollback, new-terminal input and no flashes.
// survival requires unchanged daemon, live marker, original-session echo/Ctrl+C and no flashes.

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

// Count canary-titled or new non-app console/terminal-host windows as flashes; attribute only by title/owner, not conhost command-line guesses.
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
    // Report null scraped buffer text as informational because WebGL may expose no DOM rows.
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
  // Missing daemon logs are informational; inspect available lifecycle records for fatal evidence.
  if (!ctx.daemonLog) {
    return assertion(
      'daemon log free of fatal records',
      null,
      'no fatal/invalid-token records',
      'no daemon log present (informational)'
    )
  }
  // Fail fatal exceptions/invalid-token hello, retaining benign suppressed native-PTY exceptions as context.
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

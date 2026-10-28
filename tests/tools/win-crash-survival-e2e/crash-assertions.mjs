// #7742 survival: require actual main death, surviving daemon/same shell, no pwsh FailFast, same-daemon adoption and shell canary readback.
// orphaned is the locally runnable inverse, not a CI gate: require daemon death and idle-PSReadLine 0xE9 on a genuinely broken build.

function assertion(name, pass, expected, actual, detail = '') {
  return { name, pass, expected, actual, detail }
}

/** Build the ordered assertion list for the run's profile. */
export function buildCrashAssertions(ctx) {
  // Require actual crash before accepting any survival/orphan evidence.
  const mainDied = assertion(
    'main process actually died (crash landed)',
    Boolean(ctx.mainDied),
    'main pid dead after taskkill',
    String(ctx.mainDied)
  )
  const profileAssertions =
    ctx.profile === 'orphaned' ? orphanedAssertions(ctx) : survivalAssertions(ctx)
  return [mainDied, ...profileAssertions]
}

function survivalAssertions(ctx) {
  const failFastDetail = (ctx.failFastEvents ?? [])
    .slice(0, 3)
    .map((e) => `${e.provider}#${e.id}@${e.timeCreated}`)
    .join('; ')
  return [
    assertion(
      'daemon survives main crash (PID still alive)',
      Boolean(ctx.daemonAliveAfterCrash),
      `daemon pid ${ctx.preDaemonPid} alive after crash`,
      String(ctx.daemonAliveAfterCrash)
    ),
    assertion(
      'interactive shell survives main crash (PID still alive)',
      Boolean(ctx.shellAliveAfterCrash),
      `shell pid ${ctx.shellPid} alive after crash`,
      String(ctx.shellAliveAfterCrash)
    ),
    assertion(
      'zero pwsh FailFast / 0xE9 during crash window',
      (ctx.failFastEvents ?? []).length === 0,
      '0 pwsh FailFast events',
      `${(ctx.failFastEvents ?? []).length} events`,
      failFastDetail
    ),
    assertion(
      'relaunch adopts the same daemon (PID unchanged)',
      ctx.preDaemonPid != null &&
        ctx.preDaemonPid === ctx.postDaemonPid &&
        Boolean(ctx.postDaemonAlive),
      `daemon pid ${ctx.preDaemonPid} adopted (not re-forked)`,
      `post pid ${ctx.postDaemonPid} (alive: ${ctx.postDaemonAlive})`
    ),
    assertion(
      'reattached UI is bound to the SAME survivor shell (env sentinel reads back)',
      Boolean(ctx.reattachProven),
      'survivor shell env sentinel readable via reattached terminal',
      String(ctx.reattachProven)
    )
  ]
}

function orphanedAssertions(ctx) {
  // Inverse requires daemon death plus secondary pwsh FailFast at live PSReadLine console read; fixed builds must fail these assertions.
  return [
    assertion(
      'daemon dies with main crash (old #7742 behavior)',
      ctx.daemonAliveAfterCrash === false,
      `daemon pid ${ctx.preDaemonPid} dead after crash`,
      `alive: ${ctx.daemonAliveAfterCrash}`
    ),
    assertion(
      'pwsh FailFast / 0xE9 fired during crash window',
      (ctx.failFastEvents ?? []).length > 0,
      '>=1 pwsh FailFast event',
      `${(ctx.failFastEvents ?? []).length} events`
    )
  ]
}

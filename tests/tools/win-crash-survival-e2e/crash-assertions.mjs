// Profile assertions for the crash-survival proof.
//
// Two directional profiles over the SAME observed evidence, so CI can prove the
// harness catches a regression (an --expect that disagrees with reality fails):
//   survival — the fixed #7742 behavior. The main crash actually landed, yet the
//     detached daemon and the same interactive shell PID survive, ZERO pwsh
//     FailFast events fire, a relaunch ADOPTS the same daemon PID, and the
//     reattached UI reads back the survivor shell's env sentinel (proving
//     keystrokes reach the same PTY, not a re-spawn).
//   orphaned — the OLD broken behavior. The daemon dies with main (primary) and,
//     because the shell was left idle at a live PSReadLine prompt, pwsh FailFasts
//     with 0xE9 (secondary). On a fixed build this profile is EXPECTED to fail.
//     NOTE: the orphaned direction is NOT exercised in CI (workflow_dispatch is
//     unavailable on a non-default branch) and the 0xE9 only reproduces on a
//     genuinely broken build — it is the directional inverse, documented and
//     locally runnable, not a gate.

function assertion(name, pass, expected, actual, detail = '') {
  return { name, pass, expected, actual, detail }
}

/** Build the ordered assertion list for the run's profile. */
export function buildCrashAssertions(ctx) {
  // The crash actually landing is the shared antecedent for BOTH profiles: without
  // it, every survival/orphan signal below would be meaningless.
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
  // The directional inverse: this profile passes ONLY on a build that reproduces
  // the #7742 orphaning. Daemon death is the PRIMARY inverse (deterministic);
  // pwsh FailFast is SECONDARY — faithful here only because the shell is left idle
  // at a live PSReadLine prompt, which is what queries the severed console and
  // triggers the 0xE9 on a broken build. Running this profile against a fixed
  // build makes these FAIL, which is the proof the survival assertions above are
  // not vacuous.
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

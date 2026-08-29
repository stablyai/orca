// win-update-e2e — packaged NSIS update proof harness.
//
// Given two Orca Windows installers (version N and N+1), proves what happens to
// the terminal daemon and its sessions across a real silent update, with
// machine-checkable assertions. Windows-only. See README.md for usage and the
// design context in docs/windows-terminal-update-survival-plan.md (Phase 0).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertWin32 } from './platform-guard.mjs'
import { parseArgs } from './cli-args.mjs'
import { preflight } from './preflight.mjs'
import { resolveInstaller, silentInstall, silentUninstall } from './installer-steps.mjs'
import { backupInstallState, restoreInstallState } from './registry-shortcut-backup.mjs'
import {
  launchInstalledApp,
  ensureTerminal,
  dismissOverlays,
  createTerminalTab,
  listTabIds,
  startMarker,
  readTerminalTextBestEffort,
  closeApp,
  captureFailureDiagnostics
} from './app-driver.mjs'
import { readDaemonPidFiles, findDaemonProcesses, isPidAlive } from './daemon-processes.mjs'
import { startWatch } from './window-watch.mjs'
import {
  probeEcho,
  probeHeartbeatAdvancing,
  probeCtrlCInterruptsMarker,
  probeCtrlCOnFreshLoop,
  fileMtimeMs
} from './interactivity-probes.mjs'
import { buildAssertions, renderTable, allPassed } from './assertions.mjs'
import { createSeededRepo, buildFreshProfile } from './onboarding-profile.mjs'

function log(step, msg) {
  console.log(`[win-update-e2e] ${step}: ${msg}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(opts.usage)
    return 0
  }
  if (opts.errors?.length) {
    console.error(`Argument errors:\n  - ${opts.errors.join('\n  - ')}\n${opts.usage}`)
    return 2
  }
  assertWin32('win-update-e2e')

  const installDir = opts.installDir ?? null
  const isolated = Boolean(installDir)

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const canary = `ORCA-E2E-CANARY-${runId}`
  const runDir = mkdtempSync(path.join(tmpdir(), `orca-win-update-e2e-${runId}-`))
  const userDataDir = path.join(runDir, 'userData')
  const baselinePath = path.join(runDir, 'baseline.json')
  const watchOut = path.join(runDir, 'window-watch.jsonl')
  const markerPidFile = path.join(runDir, 'marker.pid')
  const heartbeatFile = path.join(runDir, 'heartbeat.txt')
  const created = { markerPid: null, daemonPids: new Set() }

  log(
    'setup',
    `runId=${runId} runDir=${runDir} profile=${opts.expect}${isolated ? ` installDir=${installDir}` : ''}`
  )
  if (isolated && opts.keepInstall) {
    log(
      'setup',
      '--keep-install is ignored in isolated mode: the test install and its per-user ' +
        'registry hijack are always cleaned up so the real install stays safe.'
    )
  }

  const { warnings, existingInstall } = preflight({
    baselinePath,
    allowExistingInstall: opts.allowExistingInstall,
    installDir
  })
  const hadPreexistingInstall = Boolean(existingInstall)
  for (const w of warnings) {
    log('preflight-warning', w)
  }

  // Isolated mode: snapshot the shared per-user registry keys + shortcuts BEFORE
  // any install writes over them. Everything after this must run through the
  // try/finally so the snapshot is always restored, even on failure.
  let manifest = null
  if (isolated) {
    manifest = backupInstallState(runDir)
    log('isolated', `backed up install registry/shortcut state -> ${manifest.backupDir}`)
  }

  const runArgs = {
    opts,
    installDir,
    canary,
    runDir,
    userDataDir,
    baselinePath,
    watchOut,
    markerPidFile,
    heartbeatFile,
    created
  }

  // Both paths ALWAYS tear down (close the app, kill the marker/watch, uninstall)
  // and, in isolated mode, restore registry/shortcuts — whatever happens in the
  // proof body. A driving failure captures diagnostics first, then surfaces as a
  // FATAL. Teardown in a finally is what keeps a driving hang from pinning the
  // Node process alive until the CI job timeout.
  const ctx = { session: null }
  const diagDir = process.env.ORCA_E2E_DIAG_DIR || path.join(runDir, 'diag')
  let passed = false
  try {
    passed = await runProof(ctx, runArgs)
  } catch (err) {
    console.error(`[win-update-e2e] FATAL: ${err.stack || err.message}`)
    if (ctx.session?.page) {
      const diag = await captureFailureDiagnostics(ctx.session.page, diagDir, 'driving-failure')
      log('diag', `captured -> ${diagDir} (store=${diag.info?.hasStore ?? 'n/a'})`)
      if (diag.info?.bodyText) {
        log('diag', `visible text: ${diag.info.bodyText.replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
    passed = false
  } finally {
    await (isolated
      ? isolatedTeardown({
          app: ctx.session?.app,
          created,
          userDataDir,
          installDir,
          manifest,
          runDir
        })
      : teardown({
          app: ctx.session?.app,
          created,
          userDataDir,
          keepInstall: opts.keepInstall,
          hadPreexistingInstall,
          installedExePath: ctx.installedExePath ?? null,
          runDir
        }))
  }
  return passed ? 0 : 1
}

/**
 * Run the install → drive → update → relaunch → assert proof. `ctx.session` is
 * assigned as soon as each app launches so a caller's finally can tear down a
 * partially-created session on failure. Returns whether every assertion passed.
 */
async function runProof(ctx, args) {
  const {
    opts,
    installDir,
    canary,
    runDir,
    userDataDir,
    baselinePath,
    watchOut,
    markerPidFile,
    heartbeatFile,
    created
  } = args

  const fromInstaller = resolveInstaller({
    localPath: opts.from,
    releaseTag: opts.fromRelease,
    assetPattern: opts.assetPattern
  })
  log('install-base', `installing ${fromInstaller}`)
  const base = silentInstall(fromInstaller, { installDir })
  // Track the install now (not only after the update at L238) so a failure
  // anywhere before the update still tears down the base install this harness
  // created, instead of orphaning it and blocking the next run's preflight.
  ctx.installedExePath = base.exePath
  log('install-base', `installed ${base.exePath} (version ${base.version})`)

  // Seed a fresh profile (onboarding dismissed + one throwaway git repo as a
  // project) ONLY before the first launch. The relaunch must use the app's own
  // persisted state so the cold-restore/survival assertions are meaningful.
  const seededRepo = createSeededRepo(path.join(runDir, 'fixture-repo'))
  const seedProfile = buildFreshProfile({ repo: seededRepo })

  // --- Base version: launch, create sessions, start marker, record daemon ---
  let session = await launchInstalledApp({ exePath: base.exePath, userDataDir, seedProfile })
  ctx.session = session
  // A fresh profile has no terminal yet, so create a workspace + terminal, then
  // clear the post-creation overlays that would intercept typing.
  await ensureTerminal(session.page, { allowCreate: true })
  await dismissOverlays(session.page)
  const tabIds = await listTabIds(session.page)
  log('sessions', `terminal ready; tab ids: ${tabIds.join(', ')}`)

  // Baseline typed-input on the IDLE shell, before the perpetual marker loop
  // takes over the foreground (a command typed against a running loop can't
  // execute, so this must precede startMarker to be meaningful).
  const echoBeforeUpdate = await probeEcho(session.page, runDir, 'echo-pre')
  log('sessions', `pre-update echo interactive: ${echoBeforeUpdate}`)

  await startMarker(session.page, { canary, pidFile: markerPidFile, heartbeatFile })
  const markerLive = await probeHeartbeatAdvancing(heartbeatFile)
  created.markerPid = readIntFile(markerPidFile)
  log('marker', `pid=${created.markerPid} heartbeatAdvancing=${markerLive}`)

  const preDaemon = resolveScopedDaemon(userDataDir)
  preDaemon.pids.forEach((p) => created.daemonPids.add(p))
  log('daemon', `pre-update daemon pid=${preDaemon.pid} appVersion=${preDaemon.appVersion}`)
  log('daemon', `pre-update daemon exe: ${preDaemon.exePath ?? '(unknown)'}`)

  const preScrollback = await readTerminalTextBestEffort(session.page)

  // Close app normally; the detached daemon must remain alive.
  await closeApp(session.app)
  const daemonAliveAfterClose = preDaemon.pid != null && isPidAlive(preDaemon.pid)
  log('daemon', `alive after app close: ${daemonAliveAfterClose}`)

  // --- Start the console-window watch through the whole update + soak ---
  const watchDuration = 120 + opts.soakSeconds
  const watch = startWatch({ baselinePath, outPath: watchOut, durationSec: watchDuration })
  log('watch', `started (duration ${watchDuration}s) -> ${watchOut}`)

  // --- Update: install N+1 ---
  const toInstaller = resolveInstaller({
    localPath: opts.to,
    releaseTag: opts.toRelease,
    assetPattern: opts.assetPattern
  })
  log('update', `installing ${toInstaller}`)
  const updated = silentInstall(toInstaller, { installDir })
  // Record the exact dir the harness installed into so non-isolated teardown
  // uninstalls THAT and never scan-discovers the developer's real install.
  ctx.installedExePath = updated.exePath
  log('update', `installed ${updated.exePath} (version ${updated.version})`)

  // --- Relaunch and gather post-update evidence ---
  session = await launchInstalledApp({ exePath: updated.exePath, userDataDir })
  ctx.session = session
  // No create on relaunch: the session must be RESTORED, not freshly made.
  await ensureTerminal(session.page, { allowCreate: false })
  await dismissOverlays(session.page)

  const evidence = await gatherEvidence({
    profile: opts.expect,
    page: session.page,
    runDir,
    heartbeatFile,
    preDaemon,
    userDataDir,
    preScrollback,
    echoBeforeUpdate
  })
  evidence.postDaemon?.pids?.forEach((p) => created.daemonPids.add(p))

  // --- Soak, then stop the watch and evaluate ---
  log('soak', `waiting ${opts.soakSeconds}s for delayed flashes`)
  await delay(opts.soakSeconds * 1000)
  const { events } = await watch.stop()
  log('watch', `recorded ${events.length} new-window events`)

  const assertionCtx = {
    profile: opts.expect,
    canary,
    watchEvents: events,
    markerPid: created.markerPid,
    daemonLog: readDaemonLog(userDataDir),
    ...evidence
  }
  const assertions = buildAssertions(assertionCtx)
  const passed = allPassed(assertions)
  console.log(renderTable(assertions))
  log('result', passed ? 'PASS' : 'FAIL')
  return passed
}

async function gatherEvidence(args) {
  const { profile, page, runDir, heartbeatFile, preDaemon, userDataDir, preScrollback } = args
  const postDaemon = resolveScopedDaemon(userDataDir)

  if (profile === 'survival') {
    // The decisive survival signals: did the SPECIFIC pre-update daemon process
    // live through the update, and is the new app running that same relocated
    // exe or a fresh in-dir fork? Log both regardless of the assertion outcome.
    const preDaemonAliveAfter = preDaemon.pid != null && isPidAlive(preDaemon.pid)
    log(
      'daemon',
      `post-update daemon pid=${postDaemon.pid} exe: ${postDaemon.exePath ?? '(unknown)'}`
    )
    log(
      'daemon',
      `pre-update daemon pid=${preDaemon.pid} still alive after update: ${preDaemonAliveAfter}`
    )
    dumpDaemonLog(userDataDir)
    const heartbeatBefore = fileMtimeMs(heartbeatFile)
    const heartbeatAdvancedAfterUpdate = await heartbeatAdvancedSince(
      heartbeatFile,
      heartbeatBefore
    )
    // Sample marker survival BEFORE interrupting it: the pre-update shell must be
    // measured while its heartbeat loop still runs, not after
    // probeCtrlCInterruptsMarker deliberately breaks that loop.
    const markerAliveAfter = isMarkerAlive(runDir)
    log(
      'marker',
      `pid=${readIntFile(path.join(runDir, 'marker.pid'))} aliveAfterUpdate=${markerAliveAfter}`
    )
    // Interrupt the foreground loop first so the shell returns to a prompt; only
    // then can a freshly-typed command execute. Typing while the infinite
    // heartbeat loop owns the shell never runs, regardless of input health — so
    // the echo probe is meaningful only after the interrupt.
    const ctrlCInterrupted = await probeCtrlCInterruptsMarker(page, runDir, heartbeatFile)
    const echoObserved = await probeEcho(page, runDir, 'echo-post')
    return {
      preDaemonPid: preDaemon.pid,
      preDaemonAliveAfter,
      postDaemonPid: postDaemon.pid,
      postDaemonAlive: postDaemon.pid != null && isPidAlive(postDaemon.pid),
      postDaemon,
      markerAliveAfter,
      heartbeatAdvancedAfterUpdate,
      echoObserved,
      ctrlCInterrupted
    }
  }

  // cold-restore
  const postScrollback = await readTerminalTextBestEffort(page)
  const scrollbackRestored = scrollbackFidelity(preScrollback, postScrollback)
  await createTerminalTab(page)
  const echoObserved = await probeEcho(page, runDir, 'echo-fresh')
  const ctrlCInterrupted = await probeCtrlCOnFreshLoop(page, runDir)
  return {
    preDaemonPid: preDaemon.pid,
    preDaemonAliveAfter: preDaemon.pid != null && isPidAlive(preDaemon.pid),
    postDaemonPid: postDaemon.pid,
    postDaemonAlive: postDaemon.pid != null && isPidAlive(postDaemon.pid),
    postDaemon,
    scrollbackRestored,
    echoObserved,
    ctrlCInterrupted
  }
}

/**
 * Resolve THIS run's daemon, scoped to its isolated userData dir so unrelated
 * daemons on the machine are ignored. Prefers the pid file (authoritative,
 * carries appVersion); cross-checks the live process scan.
 */
function resolveScopedDaemon(userDataDir) {
  const pidFiles = readDaemonPidFiles(userDataDir)
  const scan = findDaemonProcesses(userDataDir)
  const pids = new Set()
  for (const rec of pidFiles) {
    if (typeof rec.pid === 'number') {
      pids.add(rec.pid)
    }
  }
  for (const proc of scan) {
    if (typeof proc.pid === 'number') {
      pids.add(proc.pid)
    }
  }
  const primary = pidFiles.find((r) => typeof r.pid === 'number')
  const pid = primary?.pid ?? scan[0]?.pid ?? null
  const scanEntry = scan.find((p) => p.pid === pid) ?? scan[0]
  return {
    pid,
    appVersion: primary?.appVersion ?? null,
    startedAtMs: primary?.startedAtMs ?? null,
    // Why: the daemon's exe path (first token of its command line) tells us
    // whether it was forked from the relocated userData/daemon-host copy or the
    // install-dir Orca.exe — the key survival signal.
    exePath: daemonExePath(scanEntry?.commandLine),
    pids: [...pids]
  }
}

/** Print the daemon's lifecycle log (Phase 0) so its startup/session events are
 *  visible in the CI log before teardown removes the userData dir. */
function dumpDaemonLog(userDataDir) {
  const logPath = path.join(userDataDir, 'logs', 'daemon.log')
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    log('daemon-log', `${logPath} (${lines.length} lines):`)
    for (const line of lines.slice(-40)) {
      console.log(`    ${line}`)
    }
  } catch {
    log('daemon-log', `${logPath} (unavailable)`)
  }
}

/** Extract the host exe path (first token) from a daemon command line. */
function daemonExePath(commandLine) {
  if (typeof commandLine !== 'string') {
    return null
  }
  const trimmed = commandLine.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    return end > 0 ? trimmed.slice(1, end) : null
  }
  const space = trimmed.indexOf(' ')
  return space > 0 ? trimmed.slice(0, space) : trimmed
}

function isMarkerAlive(runDir) {
  const pid = readIntFile(path.join(runDir, 'marker.pid'))
  return pid != null && isPidAlive(pid)
}

async function heartbeatAdvancedSince(heartbeatFile, sinceMs) {
  await delay(1500)
  return fileMtimeMs(heartbeatFile) > sinceMs
}

function scrollbackFidelity(before, after) {
  // WebGL renderer can leave both empty; report unknown (null) rather than a
  // false failure. When text is available, check a stable prefix survived.
  if (!before || !before.trim() || !after || !after.trim()) {
    return null
  }
  const marker = before
    .trim()
    .split('\n')
    .find((l) => l.trim().length > 3)
  if (!marker) {
    return null
  }
  return after.includes(marker.trim())
}

export function readDaemonLog(userDataDir) {
  // The daemon log (when present) is JSONL: { src, ts, pid, event, ...details }.
  // Only genuinely-bad records fail a run — matched by EVENT NAME, not by any
  // string containing "error". The daemon logs benign 'uncaught-exception-
  // suppressed' events with name:"Error" for native PTY errors it intentionally
  // swallows (src/main/daemon/daemon-entry.ts); those must never fail, and
  // 'client-hello-rejected' with reason expected-hello/protocol-mismatch is
  // normal version-skew during an update. Non-JSON lines fall back to a raw
  // FATAL match so an unstructured crash dump still counts.
  const logPath = path.join(userDataDir, 'logs', 'daemon.log')
  if (!existsSync(logPath)) {
    return null
  }
  const errorLines = []
  let suppressedCount = 0
  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      if (/\bFATAL\b/.test(line)) {
        errorLines.push(line)
      }
      continue
    }
    if (rec.event === 'uncaught-exception-suppressed') {
      suppressedCount += 1
    } else if (
      rec.event === 'uncaught-exception-fatal' ||
      (rec.event === 'client-hello-rejected' && rec.reason === 'invalid-token')
    ) {
      errorLines.push(line)
    }
  }
  return { path: logPath, errorLines, suppressedCount }
}

/**
 * Isolated-mode teardown. The harness OWNS the isolated dir by construction, so
 * it always uninstalls the test install, then ALWAYS restores the shared per-user
 * registry keys + shortcuts the installer hijacked (the uninstaller clears the
 * test install's copies; restore re-imports the real install's originals or
 * deletes freshly-created keys). Finally removes the emptied install dir + runDir.
 */
async function isolatedTeardown({ app, created, userDataDir, installDir, manifest, runDir }) {
  try {
    await closeApp(app)
  } catch {
    /* already closed / never launched */
  }
  killPid(created.markerPid)
  for (const pid of resolveScopedDaemon(userDataDir).pids) {
    killPid(pid)
  }
  for (const pid of created.daemonPids) {
    killPid(pid)
  }

  const uninstalled = silentUninstall(installDir)
  log('isolated-teardown', `uninstalled test install: ${uninstalled}`)

  try {
    const restore = restoreInstallState(manifest)
    log(
      'isolated-teardown',
      `registry restore verified=${restore.verified} imported=[${restore.imported.join(', ')}] ` +
        `deleted=[${restore.deleted.join(', ')}] shortcutsRestored=${restore.shortcutsRestored.length} ` +
        `shortcutsDeleted=${restore.shortcutsDeleted.length}`
    )
  } catch (err) {
    // Restore must never be silently skipped — surface it loudly and point at the
    // manifest so the shared keys can be recovered by hand.
    console.error(
      `\n*** WIN-UPDATE-E2E: registry/shortcut restore THREW: ${err.stack || err.message}\n` +
        `    Recover manually from the backups under ${manifest?.backupDir}. ***\n`
    )
  }

  removeDirIfEmpty(installDir)
  rmSync(runDir, { recursive: true, force: true })
}

/** Remove a directory only if it is empty (best-effort; leaves non-empty dirs). */
function removeDirIfEmpty(dir) {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* leave it in place */
  }
}

async function teardown({
  app,
  created,
  userDataDir,
  keepInstall,
  hadPreexistingInstall,
  installedExePath,
  runDir
}) {
  try {
    await closeApp(app)
  } catch {
    /* already closed */
  }
  // Kill ONLY processes this harness created: the marker and this run's daemon
  // (scoped to the isolated userData). Never touch pre-existing user processes.
  killPid(created.markerPid)
  for (const pid of resolveScopedDaemon(userDataDir).pids) {
    killPid(pid)
  }
  for (const pid of created.daemonPids) {
    killPid(pid)
  }

  if (keepInstall) {
    log('teardown', `--keep-install set; leaving install + ${runDir}`)
    return
  }
  // Only uninstall when the harness fully OWNS the install (no pre-existing
  // build). When it overwrote a developer's existing install, leave it in place
  // — uninstalling would remove a build we did not put there.
  if (hadPreexistingInstall) {
    console.log(
      '\n*** NOTE: an Orca install existed before this run. It was OVERWRITTEN and the\n' +
        '    --to version is now installed. Your prior build was NOT restored — reinstall\n' +
        '    your intended build if needed. Skipping uninstall. ***\n'
    )
  } else if (installedExePath) {
    // Uninstall ONLY the exact directory the harness installed into this run,
    // with the explicit default-location opt-in (non-isolated mode legitimately
    // installs to the default path and owns it here). Never scan-and-discover.
    const uninstalled = silentUninstall(path.dirname(installedExePath), {
      allowDefaultLocation: true
    })
    log('teardown', `uninstalled: ${uninstalled}`)
  } else {
    log('teardown', 'no install path recorded; skipping uninstall (nothing owned to remove)')
  }
  rmSync(runDir, { recursive: true, force: true })
}

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already dead */
  }
}

function readIntFile(filePath) {
  try {
    const n = Number(readFileSync(filePath, 'utf8').trim())
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Only run the orchestrator when invoked directly, so the module (and
// readDaemonLog) can be imported by tests without kicking off a real install.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main()
    .then((code) => {
      // Why: force-exit. A launched Electron app or the window-watch child can
      // keep libuv handles open; without this the process lingers to the CI job
      // timeout instead of exiting when the run is logically done.
      process.exit(code)
    })
    .catch((err) => {
      console.error('[win-update-e2e] FATAL:', err.stack || err.message)
      process.exit(1)
    })
}

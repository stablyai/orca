// win-crash-survival-e2e — packaged crash-survival proof harness.
//
// GitHub #7742: on Windows, when Orca's main/renderer process crashed, open
// terminal PTYs were orphaned and PowerShell hard-crashed with a 0xE9 "No
// process is on the other end of the pipe" FailFast, because the terminal daemon
// (hosting the ConPTYs) died together with the main process and severed the
// console pipe. The fix relocates the daemon into a standalone, detached
// orca-terminal-daemon.exe that survives main death (src/main/daemon/
// daemon-host-relocation.ts). win-update-e2e proves the daemon survives a
// Windows UPDATE; this harness proves it survives a CRASH of the main process.
//
// Flow: launch the installed app (isolated userData) → open a plain terminal and,
// typing DIRECTLY into the interactive shell, stamp a per-shell env sentinel plus
// that shell's own $PID (leaving it idle at a live PSReadLine prompt, the faithful
// #7742 crash condition) → force-kill ONLY the real app main (no tree-kill, no
// graceful close) → prove the main actually died, then that the daemon + that same
// shell PID stay alive with no pwsh FailFast → relaunch, adopt the surviving
// daemon, and prove the reattached UI is bound to the SAME survivor shell by
// reading back its env sentinel (a re-spawned shell would not have it).
// Windows-only. See README.md.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertWin32 } from '../win-update-e2e/platform-guard.mjs'
import {
  launchInstalledApp,
  ensureTerminal,
  dismissOverlays,
  createTerminalTab,
  listTabIds,
  typeLine,
  sendCtrlC,
  waitForTerminalReady,
  closeApp,
  captureFailureDiagnostics,
  resolveElectronMainPid
} from '../win-update-e2e/app-driver.mjs'
import {
  findDaemonProcesses,
  isPidAlive,
  readDaemonPidFiles
} from '../win-update-e2e/daemon-processes.mjs'
import { createSeededRepo, buildFreshProfile } from '../win-update-e2e/onboarding-profile.mjs'
import { renderTable, allPassed } from '../win-update-e2e/assertions.mjs'
import { quotePowerShellLiteral } from '../win-update-e2e/powershell-runner.mjs'
import { parseArgs } from './cli-args.mjs'
import { crashMainProcess, scanPwshFailFast } from './crash-step.mjs'
import { buildCrashAssertions } from './crash-assertions.mjs'
import { selectScopedDaemon } from './daemon-identity.mjs'
import { reattachSentinelMatches, selectCreatedTabId } from './reattach-proof.mjs'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'
// The per-shell env var stamped into the interactive shell; reading it back after
// relaunch proves keystrokes reach the SAME survivor shell (a fresh re-spawn lacks it).
const SENTINEL_ENV = 'ORCA_CRASH_SENTINEL'

function log(step, msg) {
  console.log(`[win-crash-survival-e2e] ${step}: ${msg}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(opts.usage)
    return 0
  }
  // Assert win32 BEFORE surfacing arg errors so an off-win32 invocation gets the
  // clear platform message, not a confusing "no Orca.exe found" default-resolution
  // failure.
  assertWin32('win-crash-survival-e2e')
  if (opts.errors?.length) {
    console.error(`Argument errors:\n  - ${opts.errors.join('\n  - ')}\n${opts.usage}`)
    return 2
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const canary = `ORCA-CRASH-SENTINEL-${runId}`
  const runDir = mkdtempSync(path.join(tmpdir(), `orca-win-crash-e2e-${runId}-`))
  const userDataDir = path.join(runDir, 'userData')
  const shellPidFile = path.join(runDir, 'shell.pid')
  const reattachFile = path.join(runDir, 'reattach.txt')

  log('setup', `runId=${runId} runDir=${runDir} profile=${opts.expect} exe=${opts.exePath}`)

  const ctx = { session: null }
  const diagDir = process.env.ORCA_E2E_DIAG_DIR || path.join(runDir, 'diag')
  let passed = false
  try {
    passed = await runProof(ctx, { opts, canary, runDir, userDataDir, shellPidFile, reattachFile })
    if (!passed && ctx.session?.page) {
      const diag = await captureFailureDiagnostics(ctx.session.page, diagDir, 'assertion-failure')
      log('diag', `captured -> ${diagDir} (store=${diag.info?.hasStore ?? 'n/a'})`)
    }
  } catch (err) {
    console.error(`[win-crash-survival-e2e] FATAL: ${err.stack || err.message}`)
    if (ctx.session?.page) {
      const diag = await captureFailureDiagnostics(ctx.session.page, diagDir, 'driving-failure')
      log('diag', `captured -> ${diagDir} (store=${diag.info?.hasStore ?? 'n/a'})`)
    }
    passed = false
  } finally {
    await teardown({ app: ctx.session?.app, userDataDir, keepProfile: opts.keepProfile, runDir })
  }
  return passed ? 0 : 1
}

/**
 * Run the launch → crash → survive → relaunch → assert proof. `ctx.session` is
 * assigned as each app launches so a caller's finally can tear down a partial
 * session. Returns whether every assertion passed.
 */
async function runProof(ctx, args) {
  const { opts, canary, runDir, userDataDir, shellPidFile, reattachFile } = args

  // Seed a fresh profile (onboarding dismissed + one throwaway repo) ONLY before
  // the first launch. The relaunch must use the app's own persisted state so the
  // reattach/adoption assertions are meaningful.
  const seededRepo = createSeededRepo(path.join(runDir, 'fixture-repo'))
  const seedProfile = buildFreshProfile({ repo: seededRepo })

  // --- First launch: open a plain terminal and stamp the interactive shell ---
  let session = await launchInstalledApp({ exePath: opts.exePath, userDataDir, seedProfile })
  ctx.session = session
  await ensureTerminal(session.page, { allowCreate: true })
  await dismissOverlays(session.page)
  // Opening the seeded workspace lands on its default tab (an agent, not a bare
  // shell). Add an explicit plain-terminal tab so the sentinel commands run in a
  // real pwsh prompt — typing shell commands into an agent TUI would never run.
  const initialTabIds = await listTabIds(session.page)
  await createTerminalTab(session.page)
  await dismissOverlays(session.page)
  const tabIds = await listTabIds(session.page)
  const terminalTabId = selectCreatedTabId(initialTabIds, tabIds)
  await waitForTerminalReady(session.page, 60_000, terminalTabId)
  log('sessions', `terminal ready; created=${terminalTabId}; tab ids: ${tabIds.join(', ')}`)

  // Type DIRECTLY into the interactive shell (not a nested powershell) so $env and
  // $PID belong to THIS shell: stamp the env sentinel and record the shell's own
  // PID. The command completes fast, leaving the shell idle at a live PSReadLine
  // prompt — the exact state that FailFasts with 0xE9 on a broken build. The pid
  // file appearing also proves keystrokes reached and ran in the shell.
  await typeLine(
    session.page,
    `$env:${SENTINEL_ENV}='${canary}'; Set-Content -LiteralPath ${quotePowerShellLiteral(shellPidFile)} -Value $PID`,
    terminalTabId
  )
  const shellPid = await waitForIntFile(shellPidFile, 15_000)
  log('shell', `interactive shell pid=${shellPid} (sentinel ${SENTINEL_ENV}=${canary})`)

  const preDaemon = resolveScopedDaemon(userDataDir)
  log('daemon', `pre-crash daemon pid=${preDaemon.pid} appVersion=${preDaemon.appVersion}`)

  // Resolve the REAL Electron main pid from INSIDE the main process. On this
  // packaged build app.process().pid is a launcher stub that immediately re-execs
  // the actual browser process; killing the stub would leave the real main (and
  // its single-instance lock) alive and make survival vacuously true. app.evaluate
  // runs in the main process, so process.pid there is the exact main of the
  // instance this harness launched — authoritative, not a machine-wide scan.
  const mainPid = await resolveElectronMainPid(session.app, { allowLauncherFallback: false })
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    throw new Error(`could not resolve app main pid (got ${mainPid})`)
  }

  // --- CRASH: force-kill ONLY the real main (no /T tree-kill, no graceful close) ---
  const crashStartMs = Date.now()
  log('crash', `taskkill /F /PID ${mainPid} (real main, no /T) — abrupt main-process death`)
  crashMainProcess(mainPid)
  // The crashed app's driver is dead; drop it so teardown never re-closes it.
  ctx.session = null

  // Prove the crash actually LANDED before trusting any survival signal — an
  // assertion that never fires would make the whole proof vacuous.
  const mainDied = await waitForPidDead(mainPid, 15_000)
  log('crash', `main pid ${mainPid} dead: ${mainDied}`)

  // Observe the survival window: the daemon and the SAME shell PID must keep running.
  await delay(opts.soakSeconds * 1000)
  const daemonAliveAfterCrash = preDaemon.pid != null && isPidAlive(preDaemon.pid)
  const shellAliveAfterCrash = shellPid != null && isPidAlive(shellPid)
  log(
    'crash',
    `after crash: daemonAlive=${daemonAliveAfterCrash} shellAlive=${shellAliveAfterCrash}`
  )

  // --- Relaunch: adopt the surviving daemon and prove the reattached UI is the
  //     same survivor shell (env sentinel reads back) ---
  clearSingletonLocks(userDataDir)
  session = await launchInstalledApp({ exePath: opts.exePath, userDataDir })
  ctx.session = session
  let reattachProven = false
  try {
    // No create on relaunch: the terminal must be RESTORED, not freshly made.
    await ensureTerminal(session.page, { allowCreate: false })
    await dismissOverlays(session.page)
    reattachProven = await proveReattachedShell(session.page, {
      file: reattachFile,
      expectedCanary: canary,
      expectedShellPid: shellPid,
      terminalTabId
    })
  } catch (err) {
    log('relaunch', `reattach proof did not complete: ${err.message}`)
  }
  log('relaunch', `reattached UI bound to survivor shell: ${reattachProven}`)

  const postDaemon = resolveScopedDaemon(userDataDir)
  const postDaemonAlive = postDaemon.pid != null && isPidAlive(postDaemon.pid)
  log('daemon', `post-relaunch daemon pid=${postDaemon.pid} alive=${postDaemonAlive}`)

  // Why: PowerShell can stay alive on a severed ConPTY until the next console
  // read. Scan after the reattach keystroke so the user-visible 0xE9 is covered.
  const { events: failFastEvents } = scanPwshFailFast(crashStartMs)
  log('event-log', `pwsh FailFast/0xE9 events since crash: ${failFastEvents.length}`)
  for (const e of failFastEvents.slice(0, 3)) {
    log('event-log', `  ${e.provider}#${e.id}@${e.timeCreated}`)
  }

  const assertions = buildCrashAssertions({
    profile: opts.expect,
    shellPid,
    preDaemonPid: preDaemon.pid,
    postDaemonPid: postDaemon.pid,
    postDaemonAlive,
    mainDied,
    daemonAliveAfterCrash,
    shellAliveAfterCrash,
    reattachProven,
    failFastEvents
  })
  const passed = allPassed(assertions)
  console.log(renderTable(assertions, 'win-crash-survival-e2e'))
  log('result', passed ? 'PASS' : 'FAIL')
  return passed
}

/**
 * Prove the reattached UI is bound to the SAME survivor shell: type a command that
 * writes the shell's own $PID plus the persisted env sentinel to a file, then
 * confirm the sentinel (and PID) match. A freshly re-spawned shell would not carry
 * the env var. Targets the exact pre-crash tab id so the probe cannot type shell
 * commands into an unrelated agent tab. Repeats the idempotent command while the
 * restored pane transport converges; a filesystem match, not elapsed time, wins.
 */
async function proveReattachedShell(
  page,
  { file, expectedCanary, expectedShellPid, terminalTabId }
) {
  const restoredTabIds = await listTabIds(page)
  log('relaunch', `restored tab ids: ${restoredTabIds.join(', ')}; target=${terminalTabId}`)
  const targetTab = page.locator(`${SORTABLE_TAB}[data-tab-id="${terminalTabId}"]`).first()
  await targetTab.waitFor({ state: 'attached', timeout: 15_000 })

  const deadline = Date.now() + 30_000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const readinessBudgetMs = Math.max(deadline - Date.now(), 1)
    await targetTab.click({ force: true, timeout: readinessBudgetMs })
    await waitForTerminalReady(page, readinessBudgetMs, terminalTabId)
    // Why: a partially forwarded earlier attempt can leave text at PSReadLine;
    // clear it before replaying the complete idempotent proof command.
    await sendCtrlC(page, terminalTabId)
    await typeLine(
      page,
      `Set-Content -LiteralPath ${quotePowerShellLiteral(file)} -Value "$($PID)|$($env:${SENTINEL_ENV})"`,
      terminalTabId
    )
    const remainingMs = deadline - Date.now()
    const hit = await waitForSentinel(
      file,
      expectedCanary,
      expectedShellPid,
      Math.min(3_000, Math.max(remainingMs, 0))
    )
    if (hit) {
      log('relaunch', `same-shell sentinel read back on attempt ${attempt}`)
      return true
    }
    log('relaunch', `same-shell probe attempt ${attempt} produced no matching sentinel`)
  }
  return false
}

/** Poll for the reattach file and require both the per-shell canary and exact
 *  survivor PID. Either check alone is weaker than the asserted shell identity. */
async function waitForSentinel(file, expectedCanary, expectedShellPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (reattachSentinelMatches(readFileSync(file, 'utf8'), expectedCanary, expectedShellPid)) {
        return true
      }
    } catch {
      /* not written yet */
    }
    await delay(500)
  }
  return false
}

/**
 * Resolve THIS run's daemon, scoped to its isolated userData dir so unrelated
 * daemons on the machine (including the developer's live Orca) are ignored.
 * The scoped live process scan is authoritative; PID files only contribute
 * metadata after their PID matches that process.
 */
function resolveScopedDaemon(userDataDir) {
  const pidFiles = readDaemonPidFiles(userDataDir)
  const scan = findDaemonProcesses(userDataDir)
  return selectScopedDaemon(pidFiles, scan)
}

/**
 * Remove Electron/Chromium single-instance lock files a crashed main can leave
 * behind in the isolated profile, so the relaunch is not refused/redirected by a
 * stale lock. Best-effort — absent files are normal.
 */
function clearSingletonLocks(userDataDir) {
  let entries = []
  try {
    entries = readdirSync(userDataDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('Singleton')) {
      try {
        rmSync(path.join(userDataDir, entry), { recursive: true, force: true })
      } catch {
        /* leave it; relaunch may still succeed */
      }
    }
  }
}

/**
 * Tear down only what THIS harness created. Kills are re-scoped at teardown time
 * via a FRESH findDaemonProcesses(userDataDir): the interactive shell is a
 * descendant of this run's daemon, so a /T tree-kill of the freshly-discovered
 * daemon removes the daemon + OpenConsole + shell together. We deliberately do NOT
 * kill any pid captured earlier in the run — a captured pid can be recycled by the
 * OS onto an innocent process, so only pids re-verified as this run's daemon (by
 * scoped command-line match) are ever killed. Never installs/uninstalls and never
 * touches any other Orca on the box (a live user instance uses a different
 * userData and is out of scope by construction).
 */
async function teardown({ app, userDataDir, keepProfile, runDir }) {
  try {
    await closeApp(app)
  } catch {
    /* already closed / never launched */
  }
  for (const proc of findDaemonProcesses(userDataDir)) {
    killPidTree(proc.pid)
  }
  if (keepProfile) {
    log('teardown', `--keep-profile set; leaving ${runDir}`)
    return
  }
  // Best-effort: a just-killed daemon/child can briefly hold file handles under
  // the profile, so a locked rmSync must not turn cleanup into a FATAL.
  try {
    rmSync(runDir, { recursive: true, force: true })
  } catch (err) {
    log('teardown', `could not remove ${runDir} (${err.code || err.message}); leaving it`)
  }
}

function killPidTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already dead */
  }
}

/** Poll until a pid is no longer alive (the crash landed), or timeout. */
async function waitForPidDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true
    }
    await delay(500)
  }
  return false
}

function readIntFile(filePath) {
  try {
    const n = Number(readFileSync(filePath, 'utf8').trim())
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/** Poll for an int-valued file (the shell writes its PID asynchronously once the
 *  typed command runs), returning the int or null after timeoutMs. */
async function waitForIntFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = readIntFile(filePath)
    if (n != null) {
      return n
    }
    await delay(500)
  }
  return null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main()
    .then((code) => {
      // Force-exit: a launched Electron app can keep libuv handles open, which
      // would otherwise pin Node alive until the CI job timeout.
      process.exit(code)
    })
    .catch((err) => {
      console.error('[win-crash-survival-e2e] FATAL:', err.stack || err.message)
      process.exit(1)
    })
}

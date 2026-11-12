// #7742 packaged Windows crash proof: launch isolated profile, stamp interactive shell canary/PID, leave idle PSReadLine, force-kill only real main.
// Require main death, daemon/same-shell survival and no FailFast; relaunch must adopt that daemon and read the same shell canary.
// See README; win-update-e2e covers installer survival separately.

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
// Canary readback rejects a fresh shell after relaunch.
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
  // Refuse non-Windows before default exe resolution can produce misleading argument errors.
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

// Run crash/relaunch proof, assigning ctx.session early for partial-launch cleanup; return aggregate assertion success.
async function runProof(ctx, args) {
  const { opts, canary, runDir, userDataDir, shellPidFile, reattachFile } = args

  // Seed only the first launch; relaunch must exercise app-persisted restore/adoption.
  const seededRepo = createSeededRepo(path.join(runDir, 'fixture-repo'))
  const seedProfile = buildFreshProfile({ repo: seededRepo })

  let session = await launchInstalledApp({ exePath: opts.exePath, userDataDir, seedProfile })
  ctx.session = session
  await ensureTerminal(session.page, { allowCreate: true })
  await dismissOverlays(session.page)
  // Create explicit plain terminal because the seeded workspace’s default agent cannot execute shell sentinels.
  const initialTabIds = await listTabIds(session.page)
  await createTerminalTab(session.page)
  await dismissOverlays(session.page)
  const tabIds = await listTabIds(session.page)
  const terminalTabId = selectCreatedTabId(initialTabIds, tabIds)
  await waitForTerminalReady(session.page, 60_000, terminalTabId)
  log('sessions', `terminal ready; created=${terminalTabId}; tab ids: ${tabIds.join(', ')}`)

  // Stamp canary/$PID directly in the interactive shell, leaving live PSReadLine idle for faithful 0xE9 reproduction.
  // PID file creation also proves input execution.
  await typeLine(
    session.page,
    `$env:${SENTINEL_ENV}='${canary}'; Set-Content -LiteralPath ${quotePowerShellLiteral(shellPidFile)} -Value $PID`,
    terminalTabId
  )
  const shellPid = await waitForIntFile(shellPidFile, 15_000)
  log('shell', `interactive shell pid=${shellPid} (sentinel ${SENTINEL_ENV}=${canary})`)

  const preDaemon = resolveScopedDaemon(userDataDir)
  log('daemon', `pre-crash daemon pid=${preDaemon.pid} appVersion=${preDaemon.appVersion}`)

  // Use app.evaluate process.pid: packaged app.process may be a re-exec launcher stub, whose death falsely proves crash while main/lock remain alive.
  const mainPid = await resolveElectronMainPid(session.app, { allowLauncherFallback: false })
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    throw new Error(`could not resolve app main pid (got ${mainPid})`)
  }

  const crashStartMs = Date.now()
  log('crash', `taskkill /F /PID ${mainPid} (real main, no /T) — abrupt main-process death`)
  crashMainProcess(mainPid)
  // The crashed app's driver is dead; drop it so teardown never re-closes it.
  ctx.session = null

  // Require main death before trusting survival.
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

  // Scan after reattach input: severed-ConPTY PowerShell may stay alive until its next console read.
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

// Type idempotent canary/$PID readback into the exact pre-crash tab and require both matches from a file.
// Retry while transport converges; never substitute another restored/agent tab or elapsed-time success.
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
    // Clear partial PSReadLine input before retrying the complete idempotent command.
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

// Resolve the userData-scoped live daemon first; accept PID-file metadata only after identity matches.
function resolveScopedDaemon(userDataDir) {
  const pidFiles = readDaemonPidFiles(userDataDir)
  const scan = findDaemonProcesses(userDataDir)
  return selectScopedDaemon(pidFiles, scan)
}

// Best-effort remove stale isolated-profile single-instance locks left by main crash before relaunch.
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

// Teardown re-discovers daemon by scoped command line, then tree-kills its shell/console descendants.
// Never kill captured old PIDs, which may have been recycled, or unrelated profiles; never install/uninstall.
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
  // Allow briefly locked post-kill files without masking proof results as cleanup FATAL.
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
      // Force exit after proof/teardown because leftover app handles can otherwise linger until CI timeout.
      process.exit(code)
    })
    .catch((err) => {
      console.error('[win-crash-survival-e2e] FATAL:', err.stack || err.message)
      process.exit(1)
    })
}

// Drive packaged production DOM/ARIA without E2E-only stores. Prove input through command-written filesystem sentinels rather than canvas scraping.
// Marker canary attributes console flashes; ~500ms heartbeat proves the session remains active.

import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seedFreshProfile } from './onboarding-profile.mjs'
import { isPidAlive } from './daemon-processes.mjs'

const NEW_TAB_BUTTON = { role: 'button', name: 'New tab' }
const NEW_TERMINAL_ITEM = /New Terminal/i
const NEW_WORKSPACE_BUTTON = { role: 'button', name: 'New workspace' }
const SORTABLE_TAB = '[data-testid="sortable-tab"]'
// Target :visible because hidden duplicate panes must not receive focus or measurements.
const TERMINAL_SURFACE_VISIBLE = '[data-terminal-tab-id]:visible'
const XTERM_CONTAINER_VISIBLE = '.xterm:visible'
const XTERM_INPUT = '.xterm-helper-textarea'
const RESTRICTED_E2E_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'ORCA_E2E_HOME_DIR',
  'ORCA_E2E_USER_DATA_DIR'
])

// Launch with harness-owned userData for unique daemon scope; optional seedProfile writes only before FIRST launch, preserving later restore evidence.
export async function launchInstalledApp({
  exePath,
  userDataDir,
  seedProfile = null,
  extraEnv = {}
}) {
  const {
    ELECTRON_RUN_AS_NODE: _drop,
    CODEX_HOME: _codexHome,
    ORCA_CODEX_HOME: _orcaCodexHome,
    ...cleanEnv
  } = process.env
  void _drop
  void _codexHome
  void _orcaCodexHome
  const restrictedExtraEnvKey = Object.keys(extraEnv).find((key) =>
    RESTRICTED_E2E_ENV_KEYS.has(key.toUpperCase())
  )
  if (restrictedExtraEnvKey) {
    throw new Error(`extraEnv.${restrictedExtraEnvKey} cannot override E2E home isolation`)
  }
  mkdirSync(userDataDir, { recursive: true })
  if (seedProfile) {
    seedFreshProfile(userDataDir, seedProfile)
  }
  // Isolate Codex home separately: relocating userData does not change Node home.
  const requestedIsolatedHome = path.join(userDataDir, 'home')
  mkdirSync(requestedIsolatedHome, { recursive: true })
  // Canonicalize Windows 8.3 home aliases so Git worktree paths match Orca’s comparisons.
  const isolatedHome = realpathSync.native(requestedIsolatedHome)
  const app = await electron.launch({
    executablePath: exePath,
    args: [],
    env: {
      ...cleanEnv,
      // Packaged main honors ORCA_E2E_USER_DATA_DIR to relocate userData
      // (logs/daemon/terminal-history) under a controlled dir.
      ...extraEnv,
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      // Why: the driven app stays off the foreground so a local run doesn't steal focus.
      ORCA_BACKGROUND_LAUNCH: '1',
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCA_E2E_HOME_DIR: isolatedHome
    }
  })
  // Kill launch tree if firstWindow fails; Electron may still run after the driver times out.
  let page
  try {
    page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
  } catch (err) {
    const pid = await resolveElectronMainPid(app)
    if (pid) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
    throw err
  }
  return { app, page }
}

/** Resolve the packaged Electron main, optionally falling back to Playwright's child PID. */
export async function resolveElectronMainPid(
  app,
  { allowLauncherFallback = true, timeoutMs = 5_000 } = {}
) {
  let timeout
  try {
    // app.evaluate resolves authoritative main after packaged launcher re-exec; app.process may point at a dead stub.
    const pid = await Promise.race([
      app.evaluate(() => process.pid),
      new Promise((_, reject) => {
        // Bound main PID resolution because cleanup often has a wedged connection.
        timeout = setTimeout(() => reject(new Error('main PID resolution timed out')), timeoutMs)
        timeout.unref?.()
      })
    ])
    if (Number.isInteger(pid) && pid > 0) {
      return pid
    }
  } catch {
    /* the main connection may already be unavailable */
  } finally {
    clearTimeout(timeout)
  }
  // Crash proofs must reject unavailable main identity rather than kill a stub and falsely prove crash.
  if (!allowLauncherFallback) {
    return null
  }
  const fallbackPid = app.process()?.pid
  return Number.isInteger(fallbackPid) && fallbackPid > 0 ? fallbackPid : null
}

// Best-effort screenshot/body/store-exposure diagnostics under dir; production omits stores and driver failures must retain original assertions.
export async function captureFailureDiagnostics(page, dir, label) {
  const out = {}
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return out
  }
  try {
    await page.screenshot({
      path: path.join(dir, `${label}.png`),
      fullPage: false,
      timeout: 10_000
    })
    out.screenshot = `${label}.png`
  } catch {
    /* renderer may be unresponsive */
  }
  try {
    const info = await page.evaluate(() => ({
      hasStore: typeof window.__store,
      title: document.title,
      url: location.href,
      bodyText: (document.body?.innerText ?? '').slice(0, 4000),
      testIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .slice(0, 80),
      buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .slice(0, 60),
      tabs: Array.from(document.querySelectorAll('[data-testid="sortable-tab"]'))
        .map((el) => ({
          id: el.getAttribute('data-tab-id'),
          title: el.getAttribute('data-tab-title'),
          ariaLabel: el.getAttribute('aria-label'),
          selected: el.getAttribute('aria-selected')
        }))
        .slice(0, 40),
      activeElement: document.activeElement
        ? {
            tag: document.activeElement.tagName,
            className: document.activeElement.getAttribute('class'),
            ariaLabel: document.activeElement.getAttribute('aria-label')
          }
        : null
    }))
    writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(info, null, 2))
    out.info = info
  } catch {
    /* renderer may be unresponsive */
  }
  return out
}

/** Wait until the visible terminal surface and its xterm container are mounted.
 *  An expected tab id prevents post-restore probes from accepting another tab. */
export async function waitForTerminalReady(page, timeoutMs = 60_000, terminalTabId = null) {
  const selector = terminalTabId
    ? `[data-terminal-tab-id="${String(terminalTabId)}"]:visible`
    : TERMINAL_SURFACE_VISIBLE
  const surface = page.locator(selector).first()
  await surface.waitFor({ state: 'visible', timeout: timeoutMs })
  await surface.locator(XTERM_CONTAINER_VISIBLE).first().waitFor({
    state: 'visible',
    timeout: timeoutMs
  })
}

// Create only on first launch when no terminal exists; post-update relaunch must wait for restore without masking failure with a new workspace.
export async function ensureTerminal(page, { allowCreate = true, timeoutMs = 60_000 } = {}) {
  // Dismiss late feature tips without Escape so restored terminal receives no unsolicited keystroke.
  await dismissKnownOverlays(page)
  const visibleTerminal = page.locator(TERMINAL_SURFACE_VISIBLE).first()
  if (await visibleTerminal.isVisible().catch(() => false)) {
    await waitForTerminalReady(page, timeoutMs)
    return
  }
  if (!allowCreate) {
    // Restored-terminal timeout is restore failure, not an excuse to create.
    await waitForTerminalReady(page, timeoutMs)
    return
  }
  const newTab = page.getByRole(NEW_TAB_BUTTON.role, { name: NEW_TAB_BUTTON.name }).first()
  if (await newTab.isVisible().catch(() => false)) {
    await createTerminalTab(page)
    return
  }
  await createWorkspaceFromSeededRepo(page, timeoutMs)
  await waitForTerminalReady(page, timeoutMs)
}

// Use seeded-project composer’s Blank Terminal path so probes reach a shell rather than an agent/native folder dialog.
async function createWorkspaceFromSeededRepo(page, timeoutMs) {
  // Share one deadline across creation rather than reset each step’s budget.
  const deadline = Date.now() + timeoutMs
  const newWorkspace = page
    .getByRole(NEW_WORKSPACE_BUTTON.role, { name: NEW_WORKSPACE_BUTTON.name })
    .first()
  if (!(await tryClickWithKnownOverlayRetry(page, newWorkspace, deadline - Date.now()))) {
    // Keep locator diagnostics without spending another full click timeout.
    await newWorkspace.click({ timeout: 1 })
  }
  const composer = page.getByRole('dialog', { name: 'Create worktree' }).last()
  await composer.waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) })
  // Match Create by prefix for appended shortcut hints; fall back to Ctrl+Enter.
  const created = await tryClickWithKnownOverlayRetry(
    page,
    composer.getByRole('button', { name: /^Create worktree/ }).last(),
    Math.max(0, deadline - Date.now())
  )
  if (!created) {
    await page.keyboard.press('Control+Enter')
  }
}

const OVERLAY_DISMISS_LABELS = ['Got it', 'Dismiss setup scripts', 'Dismiss tip', 'Dismiss update']
const FEATURE_TIP_DIALOG_TITLES = [
  'Let agents drive Orca with the Orca CLI',
  'Search every agent session'
]

async function dismissKnownOverlays(page) {
  let acted = false
  for (const name of FEATURE_TIP_DIALOG_TITLES) {
    const featureTip = page.getByRole('dialog', { name }).first()
    if (!(await featureTip.isVisible().catch(() => false))) {
      continue
    }
    // Why: a global "Close" role also matches the Windows/Linux title-bar button.
    const dialogClose = featureTip.locator('[data-slot="dialog-close"]').first()
    if (await dialogClose.isVisible().catch(() => false)) {
      const clicked = await dialogClose
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false)
      acted ||= clicked
    }
  }
  for (const name of OVERLAY_DISMISS_LABELS) {
    const btn = page.getByRole('button', { name }).first()
    if (await btn.isVisible().catch(() => false)) {
      const clicked = await btn
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false)
      acted ||= clicked
    }
  }
  return acted
}

async function tryClickWithKnownOverlayRetry(page, locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  do {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    try {
      await locator.click({ timeout: Math.min(5_000, remainingMs) })
      return true
    } catch (error) {
      if (page.isClosed()) {
        throw error
      }
      await dismissKnownOverlays(page)
    }
  } while (Date.now() < deadline)
  return false
}

// Dismiss sequential feature tips/setup/update overlays best-effort so they cannot intercept terminal input.
export async function dismissOverlays(page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const acted = await dismissKnownOverlays(page)
    await page.keyboard.press('Escape').catch(() => {})
    if (!acted) {
      return
    }
    await page.waitForTimeout(400)
  }
}

/** Create a new terminal tab via the New tab menu. Returns the count after. */
export async function createTerminalTab(page) {
  await dismissOverlays(page, 1)
  const before = await page.locator(SORTABLE_TAB).count()
  await page
    .getByRole(NEW_TAB_BUTTON.role, { name: NEW_TAB_BUTTON.name })
    .first()
    .click({ force: true })
  await page.getByRole('menuitem', { name: NEW_TERMINAL_ITEM }).first().click({ force: true })
  await page.waitForFunction(
    ({ selector, prev }) => document.querySelectorAll(selector).length > prev,
    { selector: SORTABLE_TAB, prev: before },
    { timeout: 10_000 }
  )
  await waitForTerminalReady(page)
  return page.locator(SORTABLE_TAB).count()
}

/** Cheap session identifiers: the rendered tab ids. */
export async function listTabIds(page) {
  return page
    .locator(SORTABLE_TAB)
    .evaluateAll((tabs) =>
      tabs.map((t) => t.getAttribute('data-tab-id')).filter((id) => Boolean(id))
    )
}

// Click the live pane then focus its scoped textarea; offscreen textarea focus alone previously dropped input.
export async function focusActiveTerminal(page, terminalTabId = null) {
  // Clear late feature tips before focusing so keystrokes reach the shell.
  await dismissKnownOverlays(page)
  const selector = terminalTabId
    ? `[data-terminal-tab-id="${String(terminalTabId)}"]:visible`
    : TERMINAL_SURFACE_VISIBLE
  const surface = page.locator(selector).first()
  const click = surface.click({ position: { x: 24, y: 24 }, timeout: 15_000 })
  // Fail if the expected restored tab vanishes rather than type into whatever retained focus.
  await (terminalTabId ? click : click.catch(() => {}))
  // Scope textarea to the visible pane, excluding hidden duplicates.
  const input = surface.locator(XTERM_INPUT).last()
  const focus = input.focus()
  await (terminalTabId ? focus : focus.catch(() => {}))
  return input
}

/** Type a line and submit it (Enter → \r submits in the shell). */
export async function typeLine(page, text, terminalTabId = null) {
  await focusActiveTerminal(page, terminalTabId)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** Send Ctrl+C to the active terminal. */
export async function sendCtrlC(page, terminalTabId = null) {
  await focusActiveTerminal(page, terminalTabId)
  await page.keyboard.press('Control+C')
}

// Escape backticks, quotes and $ through the outer PowerShell double-quoted argument to nested powershell.exe.
// Without $ escaping, while($true) becomes while(True), silently breaking loop/heartbeat probes.
export async function runShellCommand(page, psCommand) {
  const escaped = psCommand.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')
  await typeLine(page, `powershell.exe -NoProfile -NonInteractive -Command "${escaped}"`)
}

// Start title-canary/PID/500ms heartbeat marker; return command while caller reads its PID file.
export async function startMarker(page, { canary, pidFile, heartbeatFile }) {
  const script = [
    `$host.UI.RawUI.WindowTitle='${canary}'`,
    `Set-Content -LiteralPath '${pidFile}' -Value $PID`,
    `while($true){ [System.IO.File]::WriteAllText('${heartbeatFile}',(Get-Date).ToString('o')); Start-Sleep -Milliseconds 500 }`
  ].join('; ')
  await runShellCommand(page, script)
  return script
}

// Read scrollback best-effort through exposed SerializeAddon, else DOM rows; WebGL without exposure may return empty.
export async function readTerminalTextBestEffort(page) {
  return page.evaluate(() => {
    const managers = window.__paneManagers
    if (managers && typeof managers.forEach === 'function') {
      let out = ''
      managers.forEach((m) => {
        const pane = m.getActivePane?.() ?? m.getPanes?.()[0]
        const text = pane?.serializeAddon?.serialize?.()
        if (text) {
          out += text
        }
      })
      if (out) {
        return out
      }
    }
    return Array.from(document.querySelectorAll('.xterm-rows'))
      .map((el) => el.textContent ?? '')
      .join('\n')
  })
}

const appShutdownProcesses = {
  isPidAlive,
  killTree(pid) {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
}

/** Cleanup may kill the tree; survival proofs must disable that fallback. */
export async function closeApp(
  app,
  timeoutMs = 10_000,
  { allowForceKill = true, processes = appShutdownProcesses } = {}
) {
  // A partially-created session (launch failed before assignment) passes undefined.
  if (!app) {
    return
  }
  const mainPid = await resolveElectronMainPid(app, { allowLauncherFallback: allowForceKill })
  const launcher = app.process()
  let closeStatus = 'not-started'
  let closeTimeout
  try {
    if (!allowForceKill && mainPid === null) {
      throw new Error('Cannot verify graceful close without the authoritative Electron PID')
    }
    closeStatus = 'pending'
    const closePromise = app.close().then(
      () => {
        closeStatus = 'resolved'
      },
      (error) => {
        closeStatus = 'rejected'
        throw error
      }
    )
    await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        closeTimeout = setTimeout(() => reject(new Error('close timeout')), timeoutMs)
        closeTimeout.unref?.()
      })
    ])
    if (!allowForceKill && processes.isPidAlive(mainPid)) {
      throw new Error('Playwright close resolved while the authoritative Electron PID remains live')
    }
  } catch (error) {
    if (!allowForceKill) {
      const evidence = {
        closeStatus,
        error: error instanceof Error ? error.message : String(error),
        main: readClosePidEvidence(mainPid, processes),
        launcher: {
          ...readClosePidEvidence(launcher?.pid, processes),
          exitCode: launcher?.exitCode ?? null,
          signalCode: launcher?.signalCode ?? null,
          stdio:
            launcher?.stdio.map((pipe, fd) => ({
              fd,
              destroyed: pipe?.destroyed ?? null,
              readableEnded: pipe?.readableEnded ?? null
            })) ?? []
        }
      }
      // A surviving daemon can keep the launcher's pipes open after both app processes exit.
      if (
        closeStatus === 'pending' &&
        evidence.main.state === 'exited' &&
        evidence.launcher.state === 'exited'
      ) {
        console.log(`[win-update-e2e] close-verified-by-pids: ${JSON.stringify(evidence)}`)
        return
      }
      console.error(`[win-update-e2e] strict-close-failed: ${JSON.stringify(evidence)}`)
      throw error
    }
    if (mainPid) {
      try {
        processes.killTree(mainPid)
      } catch {
        /* already gone */
      }
    }
  } finally {
    // Clear successful-close timers so shared harnesses do not retain timeout closures/handles.
    clearTimeout(closeTimeout)
  }
}

function readClosePidEvidence(pid, processes) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: pid ?? null, state: 'unverifiable', error: 'PID unavailable' }
  }
  try {
    return { pid, state: processes.isPidAlive(pid) ? 'live' : 'exited' }
  } catch (error) {
    return {
      pid,
      state: 'unverifiable',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

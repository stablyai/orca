// Drive the installed, packaged Orca app with Playwright's Electron driver.
//
// This targets a PRODUCTION build, so it must NOT depend on the e2e-only store
// exposure (window.__store / window.__paneManagers) — those exist only under a
// `--mode e2e` / VITE_EXPOSE_STORE build. Everything here uses ARIA/DOM
// selectors that ship in production (matching tests/e2e/helpers/terminal.ts and
// terminal-attention.spec.ts) and proves interactivity through filesystem
// sentinels rather than by reading the WebGL-rendered xterm buffer:
//   - typed commands write a marker FILE; the harness checks the file. This
//     proves keystrokes reached the shell AND executed — stronger, and robust,
//     than scraping canvas-rendered terminal text.
//
// The long-running marker also sets a unique window-title canary and writes a
// heartbeat file every ~500ms: the canary lets the window watch attribute any
// real console flash to our child, and the heartbeat proves the session is
// live and streaming.

import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { seedFreshProfile } from './onboarding-profile.mjs'

const NEW_TAB_BUTTON = { role: 'button', name: 'New tab' }
const NEW_TERMINAL_ITEM = /New Terminal/i
const NEW_WORKSPACE_BUTTON = { role: 'button', name: 'New workspace' }
const SORTABLE_TAB = '[data-testid="sortable-tab"]'
// Why: the layout mounts hidden duplicate panes; only the visible one is the
// live terminal, so target `:visible` to avoid focusing/measuring a hidden copy.
const TERMINAL_SURFACE_VISIBLE = '[data-terminal-tab-id]:visible'
const XTERM_CONTAINER_VISIBLE = '.xterm:visible'
const XTERM_INPUT = '.xterm-helper-textarea'

/**
 * Launch the installed Orca.exe. Pointing userDataDir at a harness-owned temp
 * dir isolates this run's daemon (its socket/token path becomes unique), so
 * daemon lookups never collide with other Orca installs/daemons on the box.
 * Pass `seedProfile` (a buildFreshProfile object) to write orca-data.json
 * BEFORE this launch — do so only on the FIRST launch, never before the
 * post-update relaunch, or the persisted session under test is destroyed.
 */
export async function launchInstalledApp({
  exePath,
  userDataDir,
  seedProfile = null,
  extraEnv = {}
}) {
  const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env
  mkdirSync(userDataDir, { recursive: true })
  if (seedProfile) {
    seedFreshProfile(userDataDir, seedProfile)
  }
  const app = await electron.launch({
    executablePath: exePath,
    args: [],
    env: {
      ...cleanEnv,
      // Packaged main honors ORCA_E2E_USER_DATA_DIR to relocate userData
      // (logs/daemon/terminal-history) under a controlled dir.
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ...extraEnv
    }
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * Best-effort diagnostics dump when driving fails: a screenshot, the visible
 * body text, and whether the e2e store is exposed (it is not in production
 * builds). Written under `dir` so CI can upload it and reveal the actual
 * post-launch DOM state. Never throws.
 */
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
        .slice(0, 60)
    }))
    writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(info, null, 2))
    out.info = info
  } catch {
    /* renderer may be unresponsive */
  }
  return out
}

/** Wait until the visible terminal surface and its xterm container are mounted. */
export async function waitForTerminalReady(page, timeoutMs = 60_000) {
  await page
    .locator(TERMINAL_SURFACE_VISIBLE)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
  await page
    .locator(XTERM_CONTAINER_VISIBLE)
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
}

/**
 * Get the app to an interactive terminal.
 *   - `allowCreate` true (first launch): if no terminal is visible, create a
 *     workspace from the seeded repo (or a new tab if a workspace already
 *     exists) — the drivable composer, not the native folder dialog.
 *   - `allowCreate` false (post-update relaunch): the session should be
 *     RESTORED, so only wait for the restored terminal — never create a second
 *     workspace (which would mask a broken restore).
 */
export async function ensureTerminal(page, { allowCreate = true, timeoutMs = 60_000 } = {}) {
  const visibleTerminal = page.locator(TERMINAL_SURFACE_VISIBLE).first()
  if (await visibleTerminal.isVisible().catch(() => false)) {
    await waitForTerminalReady(page, timeoutMs)
    return
  }
  if (!allowCreate) {
    // Wait for the restored terminal to appear; a timeout here is a real
    // (asserted) failure of session restore, not a driving gap.
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

/**
 * Drive the "New workspace" composer to create a worktree from the single
 * seeded project. The composer is in-app DOM (unlike the native Add-Project
 * dialog): open it, choose the "Blank Terminal" mode so the worktree opens a
 * plain terminal (not an agent), then submit "Create worktree".
 */
async function createWorkspaceFromSeededRepo(page, timeoutMs) {
  await page
    .getByRole(NEW_WORKSPACE_BUTTON.role, { name: NEW_WORKSPACE_BUTTON.name })
    .first()
    .click({ timeout: timeoutMs })
  // Choose the plain-terminal mode (best-effort — if it is already the default
  // or the label differs, the create below still produces a worktree).
  await page
    .getByRole('button', { name: 'Blank Terminal' })
    .first()
    .click({ timeout: 15_000 })
    .catch(() => {})
  // Submit. The create button's accessible name carries the shortcut hint
  // ("Create worktreeCtrl"), so match by prefix; fall back to the documented
  // Ctrl+Enter shortcut if the button is not directly clickable.
  const created = await page
    .getByRole('button', { name: /^Create worktree/ })
    .last()
    .click({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!created) {
    await page.keyboard.press('Control+Enter')
  }
}

const OVERLAY_DISMISS_LABELS = ['Got it', 'Dismiss setup scripts', 'Dismiss tip', 'Dismiss update']

/**
 * Best-effort dismissal of the modals/banners that appear after creating a
 * worktree (a full-screen "Got it" feature-tip modal, the setup-script prompt,
 * update banner) and intercept all input over the terminal. Loops because tips
 * can appear in sequence. Never throws.
 */
export async function dismissOverlays(page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    let acted = false
    for (const name of OVERLAY_DISMISS_LABELS) {
      const btn = page.getByRole('button', { name }).first()
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 3_000 }).catch(() => {})
        acted = true
      }
    }
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

/**
 * Focus the live terminal so keystrokes reach the shell. Clicking the visible
 * xterm surface is what actually gives xterm keyboard focus — focusing the
 * off-screen helper textarea alone does not, which is why typed input was being
 * dropped. Click the pane, then focus the helper textarea as a belt-and-braces.
 */
export async function focusActiveTerminal(page) {
  // A feature-tip modal can appear late and swallow keystrokes; clear any before
  // focusing so typed commands actually reach the shell.
  for (const name of OVERLAY_DISMISS_LABELS) {
    const btn = page.getByRole('button', { name }).first()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2_000 }).catch(() => {})
    }
  }
  const surface = page.locator(TERMINAL_SURFACE_VISIBLE).first()
  await surface.click({ position: { x: 24, y: 24 }, timeout: 15_000 }).catch(() => {})
  // Scope the helper textarea to the visible surface so focus can't land on a
  // hidden duplicate pane's textarea (which would silently swallow keystrokes).
  const input = surface.locator(XTERM_INPUT).last()
  await input.focus().catch(() => {})
  return input
}

/** Type a line and submit it (Enter → \r submits in the shell). */
export async function typeLine(page, text) {
  await focusActiveTerminal(page)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** Send Ctrl+C to the active terminal. */
export async function sendCtrlC(page) {
  await focusActiveTerminal(page)
  await page.keyboard.press('Control+C')
}

/**
 * Run a PowerShell command inside the active terminal by invoking a nested
 * powershell.exe. The command is wrapped in double quotes for the OUTER
 * interactive shell (also pwsh), which would otherwise expand `$var`, `$(...)`
 * and consume backticks before the nested shell sees them — so escape backticks,
 * quotes, and `$`. Without the `$` escape, `while($true)` reaches the nested
 * shell as `while(True)` and never runs (the bug that silently broke every
 * loop/heartbeat probe while simple `$`-free commands worked).
 */
export async function runShellCommand(page, psCommand) {
  const escaped = psCommand.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$')
  await typeLine(page, `powershell.exe -NoProfile -NonInteractive -Command "${escaped}"`)
}

/**
 * Start the long-running marker in the active terminal: sets the canary window
 * title, records its own PID, and heartbeats a file every 500ms. Returns the
 * command string (the caller reads the pid file to learn the marker PID).
 */
export async function startMarker(page, { canary, pidFile, heartbeatFile }) {
  const script = [
    `$host.UI.RawUI.WindowTitle='${canary}'`,
    `Set-Content -LiteralPath '${pidFile}' -Value $PID`,
    `while($true){ [System.IO.File]::WriteAllText('${heartbeatFile}',(Get-Date).ToString('o')); Start-Sleep -Milliseconds 500 }`
  ].join('; ')
  await runShellCommand(page, script)
  return script
}

/**
 * Best-effort read of the active terminal's visible text, for the cold-restore
 * scrollback fidelity check. Prefers the SerializeAddon when the build happens
 * to expose paneManagers; falls back to DOM rows (populated only under the DOM
 * renderer, so this may be empty under WebGL — hence best-effort).
 */
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

/**
 * Close the app gracefully; force-kill its process tree on timeout. Mirrors
 * tests/e2e/helpers/electron-process-shutdown.ts so the daemon (detached) is
 * left alive exactly as a normal quit would.
 */
export async function closeApp(app, timeoutMs = 10_000) {
  const proc = app.process()
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), timeoutMs))
    ])
  } catch {
    if (proc?.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
  }
}

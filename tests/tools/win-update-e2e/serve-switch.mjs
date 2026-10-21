// Packaged-Windows D7: a terminal the installed desktop app opened (its daemon forked from the
// relocated %LOCALAPPDATA%\Orca\daemon-host) survives `orca serve` taking the same profile on
// orcad, and the desktop reattaches it afterwards. Also proves the desktop still writes its
// settings once orcad has applied its data-root ACL. Windows-only; run on a disposable runner.
//
//   node tests/tools/win-update-e2e/serve-switch.mjs --installer dist/orca-windows-setup.exe \
//     --template out/orcad-template

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertWin32 } from './platform-guard.mjs'
import { silentInstall, silentUninstall } from './installer-steps.mjs'
import {
  launchInstalledApp,
  ensureTerminal,
  dismissOverlays,
  startMarker,
  readTerminalTextBestEffort,
  closeApp,
  captureFailureDiagnostics
} from './app-driver.mjs'
import { readDaemonPidFiles, findDaemonProcesses, isPidAlive } from './daemon-processes.mjs'
import { probeHeartbeatAdvancing } from './interactivity-probes.mjs'
import { createSeededRepo, buildFreshProfile } from './onboarding-profile.mjs'

const log = (step, msg) => console.log(`[serve-switch] ${step}: ${msg}`)
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) })
  log(ok ? 'PASS' : 'FAIL', `${name}${detail ? ` (${detail})` : ''}`)
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : process.argv[index + 1]
}

function scopedDaemon(userDataDir) {
  const record = readDaemonPidFiles(userDataDir).find((entry) => typeof entry.pid === 'number')
  const proc = findDaemonProcesses(userDataDir).find((entry) => entry.pid === record?.pid)
  return { pid: record?.pid ?? null, commandLine: proc?.commandLine ?? '' }
}

function killPid(pid, { tree = false } = {}) {
  if (Number.isInteger(pid) && pid > 0) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), ...(tree ? ['/T'] : []), '/F'], {
        stdio: 'ignore'
      })
    } catch {
      /* already gone */
    }
  }
}

/** `orca serve` through the installed app's own CLI, on the desktop's profile. */
async function startOrcaServe(exePath, userDataDir) {
  const cli = path.join(path.dirname(exePath), 'resources', 'app.asar', 'out', 'cli', 'index.js')
  const child = spawn(
    exePath,
    [cli, 'serve', '--json', '--port', '0', '--pairing-address', '127.0.0.1'],
    {
      // orcad is opt-in on Windows until Electron serve can adopt a daemon orcad forked.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_SERVE_RUNTIME: 'orcad',
        ORCA_USER_DATA_PATH: userDataDir
      },
      windowsHide: true
    }
  )
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const readiness = await new Promise((resolve, reject) => {
    // A first run fetches and verifies the pinned Node before orcad starts.
    const timer = setTimeout(() => reject(new Error(`orca serve not ready: ${stderr}`)), 300_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`orca serve exited ${code}: ${stderr}`))
    })
  })
  return { child, readiness, stderr: () => stderr }
}

/** Windows cannot forward a stop: end the CLI, then orcad (the lock holder), never the daemon. */
function stopOrcaServe(serve, userDataDir) {
  killPid(serve.child.pid)
  try {
    killPid(JSON.parse(readFileSync(path.join(userDataDir, 'orcad.lock'), 'utf8')).pid)
  } catch {
    /* orcad already released the profile */
  }
}

/** Restored scrollback paints after the pane reattaches, not with the window. */
async function waitForText(page, text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readTerminalTextBestEffort(page)).includes(text)) {
      return true
    }
    await new Promise((settle) => setTimeout(settle, 1_000))
  }
  return false
}

async function run(ctx) {
  const installer = argValue('--installer')
  const template = argValue('--template')
  const runDir = mkdtempSync(path.join(tmpdir(), 'orca-serve-switch-'))
  const userDataDir = path.join(runDir, 'userData')
  const heartbeatFile = path.join(runDir, 'heartbeat.txt')
  const canary = `ORCA-SERVE-SWITCH-${Date.now()}`
  ctx.userDataDir = userDataDir

  const installed = silentInstall(installer)
  ctx.installDir = path.dirname(installed.exePath)
  // The per-target template packaging would verify in full; this leg needs only win32-x64.
  cpSync(template, path.join(ctx.installDir, 'resources', 'orcad-template'), { recursive: true })
  log('install', `${installed.exePath} (${installed.version})`)

  const seedProfile = buildFreshProfile({ repo: createSeededRepo(path.join(runDir, 'repo')) })
  ctx.session = await launchInstalledApp({ exePath: installed.exePath, userDataDir, seedProfile })
  await ensureTerminal(ctx.session.page, { allowCreate: true })
  await dismissOverlays(ctx.session.page)
  await startMarker(ctx.session.page, {
    canary,
    pidFile: path.join(runDir, 'marker.pid'),
    heartbeatFile
  })
  check('desktop terminal heartbeat advancing', await probeHeartbeatAdvancing(heartbeatFile))
  // Best effort, as in run.mjs: the text read can be empty under the WebGL renderer.
  const canaryReadable = (await readTerminalTextBestEffort(ctx.session.page)).includes(canary)
  const before = scopedDaemon(userDataDir)
  ctx.daemonPid = before.pid
  check(
    'desktop daemon runs from the relocated daemon-host',
    /\\Orca\\daemon-host(?:-profiles)?\\/i.test(before.commandLine),
    before.commandLine.slice(0, 160)
  )
  await closeApp(ctx.session.app, 45_000, { allowForceKill: false })
  ctx.session = null
  check('daemon outlives the desktop', isPidAlive(before.pid), `pid ${before.pid}`)

  const serve = await startOrcaServe(installed.exePath, userDataDir)
  ctx.serve = serve
  const daemon = serve.readiness.health?.terminalDaemon
  check('orca serve chose orcad', serve.stderr().includes('[serve] running on orcad'))
  check(
    'orcad adopted the relocated daemon',
    daemon?.state === 'live' && daemon.pid === before.pid,
    `${daemon?.state} pid ${daemon?.pid}`
  )
  check('terminal keeps running under orcad', await probeHeartbeatAdvancing(heartbeatFile))
  log('acl', execFileSync('icacls', [userDataDir], { encoding: 'utf8' }).trim())
  stopOrcaServe(serve, userDataDir)
  ctx.serve = null
  check('daemon outlives orcad', isPidAlive(before.pid))

  ctx.session = await launchInstalledApp({ exePath: installed.exePath, userDataDir })
  await ensureTerminal(ctx.session.page, { allowCreate: false })
  check('desktop reattached the same daemon', scopedDaemon(userDataDir).pid === before.pid)
  if (canaryReadable) {
    check('desktop shows the pre-switch terminal', await waitForText(ctx.session.page, canary))
  } else {
    log(
      'scrollback',
      'pre-switch text was not readable; reattach is proven by daemon and heartbeat'
    )
  }
  check('terminal still running after switching back', await probeHeartbeatAdvancing(heartbeatFile))
  // Durable, not just accepted: write, restart the desktop, and read it back.
  await ctx.session.page.evaluate(() => window.api.settings.set({ terminalFontSize: 15 }))
  await closeApp(ctx.session.app, 45_000, { allowForceKill: false })
  ctx.session = await launchInstalledApp({ exePath: installed.exePath, userDataDir })
  const fontSize = await ctx.session.page.evaluate(
    async () => (await window.api.settings.get()).terminalFontSize
  )
  check('desktop persists settings under the orcad data-root ACL', fontSize === 15, `${fontSize}`)
}

async function main() {
  assertWin32('serve-switch')
  const ctx = { session: null, serve: null, installDir: null, userDataDir: null, daemonPid: null }
  let failed = false
  try {
    await run(ctx)
  } catch (error) {
    failed = true
    console.error(`[serve-switch] FATAL: ${error.stack ?? error.message}`)
    if (ctx.session?.page) {
      await captureFailureDiagnostics(ctx.session.page, 'artifacts/diag', 'serve-switch')
    }
  } finally {
    await closeApp(ctx.session?.app).catch(() => {})
    if (ctx.serve) {
      stopOrcaServe(ctx.serve, ctx.userDataDir)
    }
    // The daemon's tree holds the marker loop the terminal ran.
    killPid(ctx.daemonPid, { tree: true })
    if (ctx.installDir) {
      try {
        silentUninstall(ctx.installDir, { allowDefaultLocation: true })
      } catch (error) {
        log('teardown', `uninstall failed: ${error.message}`)
      }
    }
  }
  const passed = !failed && checks.length > 0 && checks.every((entry) => entry.ok)
  log('result', passed ? 'PASS' : 'FAIL')
  return passed ? 0 : 1
}

process.exitCode = await main()

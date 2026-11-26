// Windows update scenario matrix on real installers (disposable CI runner only). Each scenario starts
// from an empty per-user install, runs the real setup.exe the way NsisUpdater does (--updated /S;
// --force-run is left out because it would launch the app with the runner's real profile), and
// records exit code, install-folder versions/hashes and processes before and after, and whether the
// installed app then opens a window. Results: <out>/scenarios.json and <out>/scenarios.md.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertWin32 } from './platform-guard.mjs'
import { runScriptFileJson, runCommandSync } from './powershell-runner.mjs'
import { launchInstalledApp, closeApp } from './app-driver.mjs'
import { isPidAlive } from './daemon-processes.mjs'

const HERE = import.meta.dirname
const PROBE = path.join(HERE, 'install-folder-probe.ps1')
const DIALOG = path.join(HERE, 'installer-dialog.ps1')
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'Programs', 'Orca')
const INSTALLER_TIMEOUT_MS = 5 * 60_000

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const installers = {
  release: arg('--release'),
  prN: arg('--pr-n'),
  prN1: arg('--pr-n1'),
  prN2: arg('--pr-n2'),
  mainN: arg('--main-n'),
  prTrace: arg('--pr-trace')
}
const outDir = arg('--out') ?? 'artifacts/scenarios'
const only = arg('--only')?.split(',')
const work = mkdtempSync(path.join(tmpdir(), 'orca-update-scenarios-'))
const rows = []
const owned = new Set()

function log(msg) {
  console.log(`[scenarios] ${msg}`)
}

function probe() {
  return runScriptFileJson(PROBE, [INSTALL_DIR])
}

function brief(snapshot) {
  if (!snapshot.present) {
    return 'absent'
  }
  return [
    `v${snapshot.exeVersion}`,
    `reg ${snapshot.displayVersion ?? '-'}`,
    snapshot.marker ? `build ${snapshot.marker}` : null,
    `exe ${snapshot.exeSha}`,
    `asar ${snapshot.asarSha}`,
    `${snapshot.fileCount} files`
  ]
    .filter(Boolean)
    .join(', ')
}

function processList(snapshot) {
  return snapshot.processes.length === 0
    ? 'none'
    : snapshot.processes.map((p) => `${p.pid} ${path.relative(INSTALL_DIR, p.path)}`).join('; ')
}

function runInstaller(exe, args, extraEnv = {}) {
  const started = Date.now()
  const result = spawnSync(exe, args, {
    timeout: INSTALLER_TIMEOUT_MS,
    env: { ...process.env, ...extraEnv }
  })
  const seconds = Math.round((Date.now() - started) / 100) / 10
  const exit = result.error ? `error ${result.error.code ?? result.error.message}` : result.status
  log(`${path.basename(exe)} ${args.join(' ')} -> exit ${exit} in ${seconds}s`)
  return { exit, seconds }
}

// One idle process running from the install folder: Orca.exe in Node mode, which maps the
// executable, its DLLs, icudtl.dat and the V8 snapshot, like a fallback daemon or a stray CLI.
function startLeftover() {
  const script = path.join(work, 'idle.js')
  writeFileSync(script, 'setInterval(() => {}, 1 << 30)\n')
  const child = spawn(path.join(INSTALL_DIR, 'Orca.exe'), [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  owned.add(child.pid)
  sleep(3000)
  log(`leftover pid ${child.pid} alive=${isPidAlive(child.pid)}`)
  return child.pid
}

// A process outside the install folder holding app.asar open without delete sharing (as an
// antivirus scanner or indexer can): no running-app check sees it.
function startOutsideHolder() {
  const asar = path.join(INSTALL_DIR, 'resources', 'app.asar').replaceAll("'", "''")
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$f = [IO.File]::Open('${asar}', 'Open', 'Read', 'Read'); Start-Sleep -Seconds 3600`
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  )
  child.unref()
  owned.add(child.pid)
  sleep(4000)
  log(`outside holder pid ${child.pid} alive=${isPidAlive(child.pid)}`)
  return child.pid
}

// One leftover the installer can find but not end: its DACL denies PROCESS_TERMINATE, which stands
// in for a UAC-elevated process (the installer has no SeDebugPrivilege enabled).
function startProtectedLeftover() {
  const pid = startLeftover()
  const result = runScriptFileJson(path.join(HERE, 'deny-terminate.ps1'), [
    '-TargetPid',
    String(pid)
  ])
  if (!result.ok) {
    throw new Error(`could not protect pid ${pid}: ${result.error}`)
  }
  return pid
}

async function launches() {
  const userDataDir = mkdtempSync(path.join(work, 'profile-'))
  let session = null
  try {
    session = await launchInstalledApp({ exePath: path.join(INSTALL_DIR, 'Orca.exe'), userDataDir })
    return true
  } catch (error) {
    log(`launch failed: ${error.message.split('\n')[0]}`)
    return false
  } finally {
    await closeApp(session?.app, 30_000, { allowForceKill: true }).catch(() => {})
  }
}

function killPid(pid) {
  if (pid && isPidAlive(pid)) {
    spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)])
  }
}

// Empty per-user install: end the runner's own test processes, run the real uninstaller, remove
// what is left (a failed scenario can leave a partial folder behind).
function cleanSlate() {
  for (const pid of owned) {
    killPid(pid)
  }
  owned.clear()
  for (const p of probe().processes) {
    killPid(p.pid)
  }
  const uninstaller = path.join(INSTALL_DIR, 'Uninstall Orca.exe')
  if (existsSync(uninstaller)) {
    spawnSync(uninstaller, ['/S', `_?=${INSTALL_DIR}`], { timeout: INSTALLER_TIMEOUT_MS })
  }
  rmSync(INSTALL_DIR, { recursive: true, force: true })
  runCommandSync(
    "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | " +
      "Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Orca*' } | Remove-Item -Recurse -Force"
  )
}

function freshInstall(exe) {
  cleanSlate()
  const result = runInstaller(exe, ['/S'])
  if (result.exit !== 0 || !probe().present) {
    throw new Error(`fresh install of ${path.basename(exe)} failed (exit ${result.exit})`)
  }
}

// Runs one update step and records the row. expect(after, ctx) returns a list of failed checks.
async function step(scenario, label, exe, args, { leftover, expect, extraEnv, during } = {}) {
  const before = probe()
  const pending = during ? during() : null
  const result = pending
    ? await pending.run(exe, args, extraEnv)
    : runInstaller(exe, args, extraEnv)
  sleep(2000)
  const after = probe()
  const leftoverAlive = leftover ? isPidAlive(leftover) : null
  const launched = after.present ? await launches() : false
  const ctx = { result, before, after, leftoverAlive, launched, dialog: pending?.dialog ?? null }
  const failures = expect ? expect(ctx) : []
  const row = {
    scenario,
    step: label,
    command: `${path.basename(exe)} ${args.join(' ')}`,
    exit: result.exit,
    seconds: result.seconds,
    before: brief(before),
    after: brief(after),
    processesBefore: processList(before),
    processesAfter: processList(after),
    leftoverAliveAfter: leftoverAlive,
    launches: launched,
    dialog: ctx.dialog,
    verdict: failures.length === 0 ? 'pass' : `FAIL: ${failures.join('; ')}`
  }
  rows.push(row)
  log(JSON.stringify(row))
  return ctx
}

const checks = {
  ok: ({ result }) => (result.exit === 0 ? [] : [`exit ${result.exit}`]),
  version:
    (want) =>
    ({ after }) =>
      after.displayVersion === want ? [] : [`installed ${after.displayVersion}, want ${want}`],
  unchanged: ({ before, after }) =>
    before.exeSha === after.exeSha &&
    before.asarSha === after.asarSha &&
    before.displayVersion === after.displayVersion &&
    before.fileCount === after.fileCount
      ? []
      : ['install folder changed'],
  failed: ({ result }) => (result.exit !== 0 ? [] : ['exit 0']),
  leftoverEnded: ({ leftoverAlive }) => (leftoverAlive === false ? [] : ['leftover still alive']),
  leftoverAlive: ({ leftoverAlive }) => (leftoverAlive === true ? [] : ['leftover ended']),
  launches: ({ launched }) => (launched ? [] : ['app does not launch'])
}

function all(...fns) {
  return (ctx) => fns.flatMap((fn) => fn(ctx))
}

const UPDATE = ['--updated', '/S']

const scenarios = {
  async '1-transitional'() {
    freshInstall(installers.release)
    await step('1 transitional (released → PR)', 'update', installers.prN, UPDATE, {
      expect: all(checks.ok, checks.version('1.4.900'), checks.launches)
    })
    freshInstall(installers.release)
    const leftover = startLeftover()
    await step(
      '1 transitional (released → PR)',
      'update with one leftover',
      installers.prN,
      UPDATE,
      {
        leftover,
        expect: all(checks.ok, checks.version('1.4.900'), checks.leftoverEnded, checks.launches)
      }
    )
  },
  async '2-one-leftover'() {
    freshInstall(installers.mainN)
    let leftover = startLeftover()
    // Observational: main's check is the old PowerShell one; the row records what it does.
    await step('2 one leftover', "main's check", installers.mainN, UPDATE, { leftover })
    freshInstall(installers.prN)
    leftover = startLeftover()
    await step('2 one leftover', "this PR's check", installers.prN1, UPDATE, {
      leftover,
      expect: all(checks.ok, checks.version('1.4.901'), checks.leftoverEnded, checks.launches)
    })
  },
  async '5-cannot-end'() {
    freshInstall(installers.prN)
    const protectedLeftover = startProtectedLeftover()
    await step(
      '5 process the installer cannot end',
      'leftover that denies termination',
      installers.prN1,
      UPDATE,
      {
        leftover: protectedLeftover,
        expect: all(checks.failed, checks.unchanged, checks.leftoverAlive, checks.launches)
      }
    )
    freshInstall(installers.prN)
    const outside = startOutsideHolder()
    await step(
      '5 process the installer cannot end',
      'outside process holding app.asar',
      installers.prN1,
      UPDATE,
      {
        leftover: outside,
        expect: all(checks.failed, checks.unchanged, checks.launches)
      }
    )
  },
  async '6-two-updates'() {
    freshInstall(installers.prN)
    await step('6 two updates in a row', 'N → N+1', installers.prN1, UPDATE, {
      expect: all(checks.ok, checks.version('1.4.901'), checks.launches)
    })
    const leftover = startLeftover()
    await step('6 two updates in a row', 'N+1 → N+2 with one leftover', installers.prN2, UPDATE, {
      leftover,
      expect: all(checks.ok, checks.version('1.4.902'), checks.leftoverEnded, checks.launches)
    })
  },
  async '7-manual'() {
    const trace = path.join(path.resolve(outDir), 'nsis-trace-manual.log')
    for (const press of ['cancel', 'ok']) {
      freshInstall(installers.prN)
      const leftover = startLeftover()
      await step(
        '7 manual install, Orca running',
        `interactive, press ${press}`,
        installers.prTrace,
        [],
        {
          leftover,
          extraEnv: { ORCA_E2E_NSIS_TRACE: trace },
          during: () => interactiveWithDialog(press, leftover),
          expect:
            press === 'cancel'
              ? all(checks.unchanged, checks.leftoverAlive, checks.dialogSawLeftoverAlive)
              : all(checks.ok, checks.leftoverEnded, checks.dialogSawLeftoverAlive)
        }
      )
    }
    freshInstall(installers.prN)
    const leftover = startLeftover()
    await step(
      '7 manual install, Orca running',
      'silent (/S, prompt auto-accepted), traced',
      installers.prTrace,
      ['/S'],
      {
        leftover,
        extraEnv: { ORCA_E2E_NSIS_TRACE: trace },
        expect: all(checks.ok, checks.leftoverEnded)
      }
    )
  }
}

checks.dialogSawLeftoverAlive = ({ dialog }) =>
  dialog?.found && dialog.leftoverAliveAtPrompt ? [] : ['prompt not seen with the leftover alive']

// Runs the interactive installer, waits for the "is running" prompt, records whether the leftover
// is still alive while the prompt is up, then presses the button.
function interactiveWithDialog(press, leftover) {
  const state = { dialog: null }
  return {
    get dialog() {
      return state.dialog
    },
    run: (exe, args, extraEnv) =>
      new Promise((resolve) => {
        const started = Date.now()
        const child = spawn(exe, args, { env: { ...process.env, ...extraEnv }, stdio: 'ignore' })
        owned.add(child.pid)
        const seen = runScriptFileJson(
          DIALOG,
          ['-InstallerPid', String(child.pid), '-TextMatch', 'is running', '-Press', 'none'],
          { timeout: 120_000 }
        )
        const aliveAtPrompt = seen.found ? isPidAlive(leftover) : null
        // Hold the prompt open a moment: nothing may be ended before the user answers.
        sleep(3000)
        const stillAliveAtPrompt = seen.found ? isPidAlive(leftover) : null
        const pressed = seen.found
          ? runScriptFileJson(DIALOG, [
              '-InstallerPid',
              String(child.pid),
              '-TextMatch',
              'is running',
              '-Press',
              press
            ])
          : null
        state.dialog = {
          found: Boolean(seen.found),
          leftoverAliveAtPrompt: Boolean(aliveAtPrompt && stillAliveAtPrompt),
          pressed: pressed?.pressed ?? null
        }
        const timer = setTimeout(() => killPid(child.pid), INSTALLER_TIMEOUT_MS)
        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve({ exit: code, seconds: Math.round((Date.now() - started) / 100) / 10 })
        })
      })
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function table() {
  const head =
    '| Scenario | Step | Installer | Exit | Before | After | Install-folder processes before → after | Leftover alive after | App launches | Result |\n' +
    '|---|---|---|---|---|---|---|---|---|---|\n'
  return (
    head +
    rows
      .map((r) =>
        [
          r.scenario,
          r.step +
            (r.dialog
              ? ` (prompt seen: ${r.dialog.found}, leftover alive at prompt: ${r.dialog.leftoverAliveAtPrompt})`
              : ''),
          `\`${r.command}\``,
          `${r.exit} (${r.seconds}s)`,
          r.before,
          r.after,
          `${r.processesBefore} → ${r.processesAfter}`,
          r.leftoverAliveAfter ?? '-',
          r.launches,
          r.verdict
        ].join(' | ')
      )
      .map((line) => `| ${line} |`)
      .join('\n')
  )
}

async function main() {
  assertWin32('update scenarios')
  mkdirSync(outDir, { recursive: true })
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) {
      continue
    }
    log(`=== ${name}`)
    try {
      await run()
    } catch (error) {
      rows.push({
        scenario: name,
        step: 'setup',
        command: '-',
        exit: '-',
        seconds: 0,
        before: '-',
        after: '-',
        processesBefore: '-',
        processesAfter: '-',
        leftoverAliveAfter: null,
        launches: false,
        dialog: null,
        verdict: `FAIL: ${error.message}`
      })
      log(`${name} errored: ${error.stack}`)
    }
  }
  cleanSlate()
  writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify(rows, null, 2))
  writeFileSync(path.join(outDir, 'scenarios.md'), `${table()}\n`)
  console.log(table())
  // Observational rows (no expectation) always pass; every expectation must hold.
  return rows.every((r) => r.verdict === 'pass') ? 0 : 1
}

process.exitCode = await main()

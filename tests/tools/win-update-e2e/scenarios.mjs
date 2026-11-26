// Windows update scenario matrix on real installers (disposable CI runner only). Each scenario starts
// from an empty per-user install, runs the real setup.exe the way NsisUpdater does (--updated /S;
// --force-run is left out because it would launch the app with the runner's real profile), and
// records exit code, install-folder versions/hashes and processes before and after, and whether the
// installed app then opens a window. Results: <out>/scenarios.json and <out>/scenarios.md.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync
} from 'node:fs'
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
  mainN1: arg('--main-n1'),
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

function shortHash(file) {
  return existsSync(file)
    ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
    : null
}

function probe() {
  const snapshot = runScriptFileJson(PROBE, [INSTALL_DIR])
  snapshot.exeSha = shortHash(path.join(INSTALL_DIR, 'Orca.exe'))
  snapshot.asarSha = shortHash(path.join(INSTALL_DIR, 'resources', 'app.asar'))
  return snapshot
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
  const ready = path.join(work, `holding-${Date.now()}.txt`)
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(HERE, 'hold-file.ps1'),
      '-Path',
      path.join(INSTALL_DIR, 'resources', 'app.asar'),
      '-ReadyFile',
      ready
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  child.unref()
  owned.add(child.pid)
  for (let i = 0; i < 60 && !existsSync(ready); i++) {
    sleep(250)
  }
  log(`outside holder pid ${child.pid} holding=${existsSync(ready)}`)
  if (!existsSync(ready)) {
    const error = existsSync(`${ready}.err`) ? readFileSync(`${ready}.err`, 'utf8') : ''
    throw new Error(
      `outside holder never opened app.asar (alive=${isPidAlive(child.pid)}): ${error}${output}`.trim()
    )
  }
  return child.pid
}

// The installer as a normal per-user install runs it: a Basic User token without Administrators
// or SeDebugPrivilege (the CI runner itself is an elevated admin).
function runDeelevated(exe, args) {
  const started = Date.now()
  const result = runScriptFileJson(
    path.join(HERE, 'run-deelevated.ps1'),
    ['-Exe', path.resolve(exe), '-Arguments', args.join(' ')],
    { timeout: INSTALLER_TIMEOUT_MS + 60_000 }
  )
  const seconds = Math.round((Date.now() - started) / 100) / 10
  log(
    `${path.basename(exe)} ${args.join(' ')} (Basic User token) -> exit ${result.exit} in ${seconds}s`
  )
  return { exit: result.exit, seconds }
}

const ASAR = path.join(INSTALL_DIR, 'resources', 'app.asar')

// Whether app.asar can be moved right now, as the old uninstaller's atomicRMDir does first.
function asarMovable() {
  try {
    renameSync(ASAR, `${ASAR}.move-probe`)
    renameSync(`${ASAR}.move-probe`, ASAR)
    return 'movable'
  } catch (error) {
    return `not movable (${error.code})`
  }
}

function installFolderProcesses() {
  const prefix = `${INSTALL_DIR}${path.sep}`.toLowerCase().replaceAll("'", "''")
  const { stdout } = runCommandSync(
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith('${prefix}') } | ` +
      'ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; cmd = $_.CommandLine } }) | ConvertTo-Json -Compress -Depth 3'
  )
  const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : []
  return Array.isArray(parsed) ? parsed : [parsed]
}

// One leftover that holds app.asar the way Orca itself does: the installed Orca.exe in Electron
// mode (it has loaded its main code from app.asar), reduced to that one main process. GPU and
// network service run inside it so there are no children to restart; any other child is ended.
let appLeftoverNote = null
function startAppLeftover() {
  const { ELECTRON_RUN_AS_NODE: _drop, CODEX_HOME: _codex, ...env } = process.env
  void _drop
  void _codex
  const child = spawn(
    path.join(INSTALL_DIR, 'Orca.exe'),
    ['--in-process-gpu', '--disable-gpu', '--enable-features=NetworkServiceInProcess'],
    {
      env: {
        ...env,
        ORCA_E2E_USER_DATA_DIR: mkdtempSync(path.join(work, 'leftover-profile-')),
        ORCA_BACKGROUND_LAUNCH: '1'
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  )
  child.unref()
  owned.add(child.pid)
  sleep(20_000)
  const ended = []
  for (let round = 0; round < 3; round++) {
    for (const p of installFolderProcesses()) {
      if (p.pid !== child.pid) {
        spawnSync('taskkill.exe', ['/F', '/PID', String(p.pid)])
        ended.push(`${p.pid} ${String(p.cmd ?? '').match(/--type=\S+/)?.[0] ?? 'helper'}`)
      }
    }
    sleep(5000)
  }
  const remaining = installFolderProcesses()
  appLeftoverNote =
    `Electron-mode Orca.exe pid ${child.pid} alive=${isPidAlive(child.pid)}; ` +
    `install-folder processes now ${remaining.length}; app.asar ${asarMovable()}; ` +
    `children ended: ${ended.join(', ') || 'none'}`
  log(`app leftover: ${appLeftoverNote}`)
  if (!isPidAlive(child.pid)) {
    throw new Error(`Electron-mode leftover exited: ${appLeftoverNote}`)
  }
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
async function step(scenario, label, exe, args, { leftover, expect, extraEnv, during, run } = {}) {
  const before = probe()
  const pending = during ? during() : null
  const result = pending
    ? await pending.run(exe, args, extraEnv)
    : (run ?? runInstaller)(exe, args, extraEnv)
  sleep(2000)
  const after = probe()
  const leftoverAlive = leftover ? isPidAlive(leftover) : null
  const launched = after.present ? await launches() : false
  const ctx = { result, before, after, leftoverAlive, launched, dialog: pending?.dialog ?? null }
  const leftoverNote = leftover ? appLeftoverNote : null
  appLeftoverNote = null
  const failures = expect ? expect(ctx) : []
  const row = {
    scenario,
    step: label,
    command: `${path.basename(exe)} ${args.join(' ')}${run === runDeelevated ? ' (Basic User token)' : ''}`,
    exit: result.exit,
    seconds: result.seconds,
    before: brief(before),
    after: brief(after),
    processesBefore: processList(before),
    processesAfter: processList(after),
    leftoverAliveAfter: leftoverAlive,
    launches: launched,
    dialog: ctx.dialog,
    leftoverNote,
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
  launches: ({ launched }) => (launched ? [] : ['app does not launch']),
  // Every build has its own app.asar, so a real update must change its hash.
  replaced: ({ before, after }) =>
    after.asarSha && after.asarSha !== before.asarSha ? [] : ['app.asar not replaced'],
  // Main's check must show the reported failure: a failed install or the old app.asar left in place.
  reproduced: ({ result, before, after }) =>
    result.exit !== 0 || after.asarSha === before.asarSha
      ? []
      : ["main's check did not reproduce the failure (exit 0, app.asar replaced)"]
}

function all(...fns) {
  return (ctx) => fns.flatMap((fn) => fn(ctx))
}

const UPDATE = ['--updated', '/S']

const scenarios = {
  async '1-transitional'() {
    freshInstall(installers.release)
    await step('1 transitional (released → PR)', 'update', installers.prN, UPDATE, {
      expect: all(checks.ok, checks.version('1.4.900'), checks.replaced, checks.launches)
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
        expect: all(
          checks.ok,
          checks.version('1.4.900'),
          checks.replaced,
          checks.leftoverEnded,
          checks.launches
        )
      }
    )
  },
  async '2-one-leftover'() {
    freshInstall(installers.mainN)
    let leftover = startLeftover()
    // Observational: main's PowerShell check; the row records what it does with one leftover.
    await step('2 one leftover', "main's check", installers.mainN1, UPDATE, { leftover })
    freshInstall(installers.prN)
    leftover = startLeftover()
    await step('2 one leftover', "this PR's check", installers.prN1, UPDATE, {
      leftover,
      expect: all(
        checks.ok,
        checks.version('1.4.901'),
        checks.replaced,
        checks.leftoverEnded,
        checks.launches
      )
    })
  },
  async '3-asar-holder'() {
    freshInstall(installers.mainN)
    let leftover = startAppLeftover()
    await step('3 one leftover holding app.asar', "main's check", installers.mainN1, UPDATE, {
      leftover,
      expect: checks.reproduced
    })
    freshInstall(installers.prN)
    leftover = startAppLeftover()
    await step('3 one leftover holding app.asar', "this PR's check", installers.prN1, UPDATE, {
      leftover,
      expect: all(
        checks.ok,
        checks.version('1.4.901'),
        checks.replaced,
        checks.leftoverEnded,
        checks.launches
      )
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
        run: runDeelevated,
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
      expect: all(checks.ok, checks.version('1.4.901'), checks.replaced, checks.launches)
    })
    const leftover = startLeftover()
    await step('6 two updates in a row', 'N+1 → N+2 with one leftover', installers.prN2, UPDATE, {
      leftover,
      expect: all(
        checks.ok,
        checks.version('1.4.902'),
        checks.replaced,
        checks.leftoverEnded,
        checks.launches
      )
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
              : '') +
            (r.leftoverNote ? ` (${r.leftoverNote})` : ''),
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
  log(`runner token:\n${spawnSync('whoami.exe', ['/priv'], { encoding: 'utf8' }).stdout}`)
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
        leftoverNote: null,
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

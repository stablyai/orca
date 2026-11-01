// Find minimal copied run-as-node Orca files for real ConPTY without install-dir handles; Windows packaged build required.
// --selftest validates pure logic anywhere; see README.md.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs, getUsage } from './cli.mjs'
import { inventoryAppDir, formatInventory } from './app-inventory.mjs'
import { resolveTierFileSet } from './tier-file-set.mjs'
import { copyHost } from './host-copy.mjs'
import { launchDaemonHost } from './daemon-launch.mjs'
import { runPtyEcho } from './ndjson-client.mjs'
import { assessDaemonHandles } from './loaded-module-probe.mjs'
import { runSelftest } from './selftest.mjs'

const HERE = import.meta.dirname
const FALLBACK_PROTOCOL_VERSION = 18

// Read protocol version from source so spike handshake matches the daemon.
function resolveProtocolVersion() {
  try {
    const typesPath = join(HERE, '..', '..', 'src', 'main', 'daemon', 'types.ts')
    const match = readFileSync(typesPath, 'utf8').match(/PROTOCOL_VERSION\s*=\s*(\d+)/)
    if (match) {
      return Number(match[1])
    }
  } catch {
    // Fall through to the pinned default.
  }
  return FALLBACK_PROTOCOL_VERSION
}

function makeSocketPath() {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-daemon-spike-${randomUUID().slice(0, 12)}`
  }
  return join(process.env.TMPDIR ?? '/tmp', `orca-daemon-spike-${randomUUID().slice(0, 12)}.sock`)
}

// Print a depth-limited copy listing so CI can verify require-resolvable entry/node-pty layout.
function printHostTree(hostRoot, maxDepth = 6) {
  console.log(`\n--- copied daemon-host tree: ${hostRoot} ---`)
  if (!existsSync(hostRoot)) {
    console.log('  (missing)')
    return
  }
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      const rel = relative(hostRoot, full).split('\\').join('/')
      if (e.isDirectory()) {
        console.log(`  ${rel}/`)
        if (depth < maxDepth) {
          walk(full, depth + 1)
        }
      } else {
        console.log(`  ${rel}`)
      }
    }
  }
  walk(hostRoot, 0)
}

// Print captured log tails for daemon exits before ready.
function printDaemonLogs(workDir, tailLines = 60) {
  for (const name of ['daemon.log', 'daemon-stdout.log', 'daemon-stderr.log']) {
    const p = join(workDir, name)
    console.log(`\n--- ${name} ---`)
    try {
      const text = readFileSync(p, 'utf8').trimEnd()
      const lines = text.split('\n')
      console.log(lines.slice(-tailLines).join('\n') || '(empty)')
    } catch {
      console.log('(unavailable)')
    }
  }
}

// Print raw-frame diagnostics to classify failed ConPTY round-trips from CI logs.
function printEchoDiagnostics(d) {
  if (!d) {
    console.log('  (no diagnostics captured)')
    return
  }
  console.log(`  createOrAttach response: ${JSON.stringify(d.createResponse)}`)
  console.log(`  data frames (our session): ${d.ourDataFrames}`)
  console.log(`  data frames (other sessions): ${d.otherDataFrames}`)
  console.log(`  exit events: ${JSON.stringify(d.exitEvents)}`)
  if (d.sessionsAtTimeout !== null) {
    console.log(`  listSessions at timeout: ${JSON.stringify(d.sessionsAtTimeout)}`)
  }
  const sample = d.rawSample || ''
  console.log(`  raw stream sample (${sample.length} chars): ${JSON.stringify(sample)}`)
}

async function shutdownDaemon(child) {
  if (!child || child.exitCode !== null) {
    return
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function runLaunch(opts) {
  const { appDir, workDir, tier, keepWorkDir } = opts
  const report = {
    tier,
    ready: false,
    ptyEchoOk: false,
    mainModuleOk: false,
    appDirModules: [],
    warnings: [],
    error: null
  }

  console.log(`\n=== daemon-relocation-spike (tier=${tier}) ===\n`)

  const inv = inventoryAppDir(appDir)
  console.log(formatInventory(inv))
  console.log('')

  const plan = resolveTierFileSet(inv, tier)
  report.warnings = plan.warnings
  console.log(`tier: ${plan.label}  (${plan.ops.length} copy ops)`)
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      console.error(`  WARNING: ${w}`)
    }
    report.error = 'incomplete file set for chosen tier'
    return report
  }

  const { hostRoot, hostExePath, daemonEntryPath, nodePtyNativeDir, skipped } = copyHost(
    inv,
    plan,
    workDir
  )
  if (skipped.length > 0) {
    console.error(`  copy skipped (missing sources): ${skipped.join(', ')}`)
    report.error = `required sources missing: ${skipped.join(', ')}`
    return report
  }
  console.log(`copied host: ${hostExePath}`)
  console.log(`daemon entry: ${daemonEntryPath}`)
  console.log(`node-pty native dir: ${nodePtyNativeDir || '(none)'}`)
  printHostTree(hostRoot)
  console.log('')

  const socketPath = makeSocketPath()
  const tokenPath = join(workDir, 'daemon.token')
  const logFilePath = join(workDir, 'daemon.log')
  const protocolVersion = resolveProtocolVersion()

  let child = null
  try {
    const launched = await launchDaemonHost({
      hostExePath,
      daemonEntryPath,
      socketPath,
      tokenPath,
      workDir,
      nodePtyNativeDir,
      logFilePath
    })
    child = launched.child
    report.ready = true
    console.log(`daemon ready (pid=${launched.pid})`)

    // Probe mappings before shutdown while daemon/native modules remain loaded.
    const handles = assessDaemonHandles(launched.pid, appDir, hostExePath)
    report.mainModuleOk = handles.mainModuleOk
    report.appDirModules = handles.appDirModules
    console.log(
      `handle probe: mainModuleOk=${handles.mainModuleOk} ` +
        `modules=${handles.moduleCount ?? 0} appDirResident=${handles.appDirModules.length}`
    )
    for (const m of handles.appDirModules) {
      console.error(`  APP-DIR MODULE (would lock during update): ${m}`)
    }

    const nonce = randomUUID().slice(0, 8)
    const marker = `SPIKE-OK-${nonce}`
    // Match line-start standalone marker, excluding echoed echo commands.
    const expectRe = new RegExp(`(?:^|\\r?\\n)${marker}(?:\\r|\\n)`)
    // Force powershell.exe rather than ambient COMSPEC for consistent ConPTY behavior.
    const echo = await runPtyEcho({
      socketPath,
      tokenPath,
      protocolVersion,
      command: `echo ${marker}`,
      expectRe,
      shellOverride: process.platform === 'win32' ? 'powershell.exe' : undefined
    })
    report.ptyEchoOk = true
    console.log(`pty echo: nonce round-tripped (${echo.output.length} bytes of output)`)
    console.log('pty echo diagnostics:')
    printEchoDiagnostics(echo.diagnostics)
  } catch (err) {
    // Recover child handle from pre-ready rejection so finally can stop it.
    child = child ?? err?.child ?? null
    report.error = err instanceof Error ? err.message : String(err)
    console.error(`\nFAILURE: ${report.error}`)
    if (err && err.diagnostics) {
      console.error('pty echo diagnostics:')
      printEchoDiagnostics(err.diagnostics)
    }
    printDaemonLogs(workDir)
  } finally {
    await shutdownDaemon(child)
    if (!keepWorkDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup; a locked file just means the relocation is
        // incomplete, which the handle probe already reports.
      }
    }
  }

  return report
}

function printFinalReport(report) {
  const pass =
    report.ready &&
    report.ptyEchoOk &&
    report.appDirModules.length === 0 &&
    report.mainModuleOk &&
    !report.error

  console.log('\n=== FINAL REPORT ===')
  console.log(`  tier:                 ${report.tier}`)
  console.log(`  daemon ready:         ${report.ready}`)
  console.log(`  pty echo ok:          ${report.ptyEchoOk}`)
  console.log(`  main module = copy:   ${report.mainModuleOk}`)
  console.log(`  app-dir modules:      ${report.appDirModules.length}`)
  for (const m of report.appDirModules) {
    console.log(`      - ${m}`)
  }
  if (report.error) {
    console.log(`  error:                ${report.error}`)
  }
  console.log(`  VERDICT:              ${pass ? 'PASS' : 'FAIL'}\n`)
  return pass
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help) {
    console.log(getUsage())
    return 0
  }
  if (parsed.error) {
    console.error(`error: ${parsed.error}`)
    console.error(getUsage())
    return 2
  }
  if (parsed.selftest) {
    return runSelftest() ? 0 : 1
  }

  if (process.platform !== 'win32') {
    console.error(
      'launch mode requires Windows (ConPTY + loaded-module probe). Use --selftest elsewhere.'
    )
    return 2
  }

  const report = await runLaunch(parsed.launch)
  return printFinalReport(report) ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('unexpected error:', err)
    process.exitCode = 1
  })

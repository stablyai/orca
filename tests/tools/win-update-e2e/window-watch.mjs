// Wrap background window-watch.ps1 JSONL collection; --selftest opens a transient real console on an isolated Windows runner to verify detection.

import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertWin32 } from './platform-guard.mjs'
import { runScriptFileJson, spawnScriptFile, runCommandSync } from './powershell-runner.mjs'

const HERE = import.meta.dirname
const WATCH_SCRIPT = path.join(HERE, 'window-watch.ps1')
const ENUM_SCRIPT = path.join(HERE, 'window-enum.ps1')

// Write baseline visible-window snapshot, normalizing PS 5.1 object/flat/nested arrays.
export function captureBaseline(baselinePath) {
  assertWin32('window-watch baseline')
  const parsed = runScriptFileJson(ENUM_SCRIPT)
  const windows = normalizeWindows(parsed.windows)
  writeFileSync(baselinePath, JSON.stringify({ windows }, null, 2))
  return windows
}

function normalizeWindows(raw) {
  if (!raw) {
    return []
  }
  // PS 5.1 ConvertTo-Json can hand back a single object, a flat array, or (from
  // a stray comma operator) a one-element array wrapping the real array.
  if (Array.isArray(raw)) {
    if (raw.length === 1 && Array.isArray(raw[0])) {
      return raw[0]
    }
    return raw
  }
  return [raw]
}

// Watch baseline-relative new windows until stop-file or durationSec; return a stop handle yielding events.
export function startWatch({ baselinePath, outPath, stopFile, durationSec = 600, pollMs = 500 }) {
  assertWin32('window-watch')
  const resolvedStopFile = stopFile ?? `${outPath}.stop`
  if (existsSync(resolvedStopFile)) {
    rmSync(resolvedStopFile)
  }

  const child = spawnScriptFile(WATCH_SCRIPT, [
    '-BaselinePath',
    baselinePath,
    '-OutPath',
    outPath,
    '-StopFile',
    resolvedStopFile,
    '-DurationSec',
    String(durationSec),
    '-PollMs',
    String(pollMs),
    '-EnumScript',
    ENUM_SCRIPT
  ])

  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  const exited = new Promise((resolve) => child.once('exit', resolve))

  return {
    process: child,
    stopFile: resolvedStopFile,
    outPath,
    async stop() {
      // Signal graceful stop/flush, then bound fallback kill so a wedged watch cannot hang teardown.
      writeFileSync(resolvedStopFile, 'stop')
      const timer = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(timer)
      return { events: readEvents(outPath), stderr }
    }
  }
}

/** Parse a window-watch JSONL log into an array of event objects. */
export function readEvents(outPath) {
  if (!existsSync(outPath)) {
    return []
  }
  return readFileSync(outPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

async function selftest() {
  assertWin32('window-watch --selftest')
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-winwatch-selftest-'))
  const baselinePath = path.join(dir, 'baseline.json')
  const outPath = path.join(dir, 'events.jsonl')
  const canary = `ORCA-E2E-SELFTEST-${Date.now()}`

  console.log(`[selftest] baseline snapshot -> ${baselinePath}`)
  const baseline = captureBaseline(baselinePath)
  console.log(`[selftest] baseline captured ${baseline.length} visible windows`)

  const watch = startWatch({ baselinePath, outPath, durationSec: 20, pollMs: 300 })
  // Wait for Add-Type/first poll before creating the transient window, preserving the new-window premise.
  await delay(1500)

  console.log(`[selftest] opening transient window titled ${canary}`)
  // Use Start-Process for a real console; detached Node has no console and would not test CREATE_NO_WINDOW flash detection.
  const transientScript = path.join(dir, 'transient.ps1')
  writeFileSync(transientScript, `$host.UI.RawUI.WindowTitle='${canary}'; Start-Sleep -Seconds 5`)
  runCommandSync(
    `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-File','${transientScript}'`
  )

  // Poll cycles at 300ms; 3.5s covers several polls while the window is alive.
  await delay(3500)
  const { events, stderr } = await watch.stop()
  rmSync(dir, { recursive: true, force: true })

  const caught = events.filter((e) => typeof e.title === 'string' && e.title.includes(canary))
  console.log(`[selftest] watch recorded ${events.length} new windows total`)
  if (stderr.trim()) {
    console.log(`[selftest] watch stderr:\n${stderr.trim()}`)
  }
  if (caught.length === 0) {
    console.error(
      `[selftest] FAIL: watch did not capture a window titled "${canary}". ` +
        `New windows seen: ${JSON.stringify(events.map((e) => e.title))}`
    )
    process.exitCode = 1
    return
  }
  console.log(`[selftest] PASS: caught canary window: ${JSON.stringify(caught[0])}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv.includes('--selftest')) {
    selftest().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  } else {
    console.log('Usage: node window-watch.mjs --selftest')
  }
}

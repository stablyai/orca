// Filesystem-sentinel interactivity probes for a packaged terminal session.
//
// These prove a session is interactive without reading the (WebGL) xterm
// buffer: a typed command writes a marker FILE, and the harness checks the
// file. That verifies keystrokes reached the shell AND the shell executed them.

import { existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { sendCtrlC, runShellCommand } from './app-driver.mjs'

const POLL_MS = 500

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return true
    }
    await delay(POLL_MS)
  }
  return false
}

/**
 * Type a command that writes a unique token to a sentinel file, then confirm
 * the file appears with that token. Proves typed input reaches and runs in the
 * active terminal. Returns true on success.
 */
export async function probeEcho(page, runDir, label = 'echo') {
  const token = `${label.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const file = path.join(runDir, `${label}-${token}.txt`)
  await runShellCommand(page, `Set-Content -LiteralPath '${file}' -Value '${token}'`)
  const appeared = await waitForFile(file, 15_000)
  if (!appeared) {
    return false
  }
  return readFileSync(file, 'utf8').includes(token)
}

/** Latest mtime (ms) of a file, or 0 if absent. */
export function fileMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Confirm a heartbeat file keeps advancing (session is live and streaming).
 * Samples twice Poll apart; returns true if the second sample is newer.
 */
export async function probeHeartbeatAdvancing(heartbeatFile) {
  const first = fileMtimeMs(heartbeatFile)
  await delay(1500)
  const second = fileMtimeMs(heartbeatFile)
  return second > first && second > 0
}

/**
 * Ctrl+C on a foreground marker loop: after interrupt the heartbeat must STOP
 * advancing and the shell must return to a prompt (a follow-up sentinel command
 * runs). Both conditions are required — output stopping alone could be a hang.
 */
export async function probeCtrlCInterruptsMarker(page, runDir, heartbeatFile) {
  await sendCtrlC(page)
  await delay(1500)
  const afterCtrlC = fileMtimeMs(heartbeatFile)
  await delay(1500)
  const stillLater = fileMtimeMs(heartbeatFile)
  const heartbeatStopped = stillLater === afterCtrlC
  const promptReturned = await probeEcho(page, runDir, 'post-interrupt')
  return heartbeatStopped && promptReturned
}

/**
 * cold-restore Ctrl+C: start a fresh foreground sleep loop in the active (new)
 * terminal, interrupt it, then confirm the prompt returns via a sentinel.
 */
export async function probeCtrlCOnFreshLoop(page, runDir) {
  const heartbeatFile = path.join(runDir, `fresh-loop-${Date.now()}.txt`)
  if (existsSync(heartbeatFile)) {
    rmSync(heartbeatFile)
  }
  await runShellCommand(
    page,
    `while($true){ [System.IO.File]::WriteAllText('${heartbeatFile}',(Get-Date).ToString('o')); Start-Sleep -Milliseconds 500 }`
  )
  // Let the loop spin up and prove it is actually running before interrupting.
  const running = await probeHeartbeatAdvancing(heartbeatFile)
  if (!running) {
    return false
  }
  return probeCtrlCInterruptsMarker(page, runDir, heartbeatFile)
}

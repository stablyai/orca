// Require typed commands to write filesystem sentinels, proving shell execution without WebGL buffer access.

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

// Type a unique-token file command and require matching contents to prove input execution.
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

// Sample heartbeat mtime twice Poll apart; require advancement for live streaming.
export async function probeHeartbeatAdvancing(heartbeatFile) {
  const first = fileMtimeMs(heartbeatFile)
  await delay(1500)
  const second = fileMtimeMs(heartbeatFile)
  return second > first && second > 0
}

// Require Ctrl+C to stop heartbeat AND restore an executing prompt; silence alone could mean a hang.
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

// For cold restore, start/interrupt a fresh loop and require a follow-up prompt sentinel.
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

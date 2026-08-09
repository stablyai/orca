import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

// Why: an absent WSL must stay re-checkable (a distro can finish provisioning while Orca runs),
// but every re-check spawns wsl.exe/pwsh.exe, so stable answers fall back to a low-frequency poll.
const REPROBE_BASE_DELAY_MS = 30_000
const REPROBE_MAX_DELAY_MS = 5 * 60_000
/** Consecutive identical answers before switching to the five-minute ceiling. */
const REPROBE_SETTLE_STREAK = 3

type CapabilityReprobeTimerKind = 'backoff' | 'ceiling'

type CapabilityReprobeRunner = {
  consumers: number
  timer: ReturnType<typeof globalThis.setTimeout> | null
  timerDeadline: number
  timerKind: CapabilityReprobeTimerKind | null
  unchangedStreak: number
  signature: string
  lastProbeAt: number
  probeInFlight: boolean
  probe: () => Promise<WindowsTerminalCapabilities>
  readCached: () => WindowsTerminalCapabilities
}

const runnersByOwnerKey = new Map<string, CapabilityReprobeRunner>()
let focusListenerAttached = false

function capabilitySignature(capabilities: WindowsTerminalCapabilities): string {
  return [
    capabilities.wslAvailable,
    capabilities.wslDistros.join('\u0000'),
    capabilities.pwshAvailable,
    capabilities.gitBashAvailable,
    capabilities.hostPlatform ?? ''
  ].join('|')
}

/** The answer #11295 waits for: a usable WSL. Nothing further to watch for. */
function isSettled(capabilities: WindowsTerminalCapabilities): boolean {
  return capabilities.wslAvailable && capabilities.wslDistros.length > 0
}

function clearRunnerTimer(runner: CapabilityReprobeRunner): void {
  if (runner.timer !== null) {
    globalThis.clearTimeout(runner.timer)
    runner.timer = null
  }
  runner.timerDeadline = 0
  runner.timerKind = null
}

function scheduleProbe(
  runner: CapabilityReprobeRunner,
  kind: CapabilityReprobeTimerKind,
  deadline: number
): void {
  clearRunnerTimer(runner)
  runner.timerKind = kind
  runner.timerDeadline = deadline
  runner.timer = globalThis.setTimeout(
    () => {
      runner.timer = null
      runner.timerDeadline = 0
      runner.timerKind = null
      void runProbe(runner)
    },
    Math.max(0, deadline - Date.now())
  )
}

function scheduleNextProbe(runner: CapabilityReprobeRunner): void {
  if (runner.unchangedStreak >= REPROBE_SETTLE_STREAK) {
    scheduleProbe(runner, 'ceiling', Date.now() + REPROBE_MAX_DELAY_MS)
    return
  }
  const delay = REPROBE_BASE_DELAY_MS * 2 ** runner.unchangedStreak
  scheduleProbe(runner, 'backoff', Date.now() + delay)
}

async function runProbe(runner: CapabilityReprobeRunner): Promise<void> {
  if (runner.consumers <= 0 || runner.probeInFlight || isSettled(runner.readCached())) {
    return
  }
  runner.probeInFlight = true
  runner.lastProbeAt = Date.now()
  let capabilities: WindowsTerminalCapabilities
  try {
    capabilities = await runner.probe().catch(() => runner.readCached())
  } finally {
    runner.probeInFlight = false
  }
  if (runner.consumers <= 0) {
    return
  }
  if (capabilitySignature(capabilities) === runner.signature) {
    runner.unchangedStreak += 1
  } else {
    // A moving answer means the host is still changing; watch it closely again.
    runner.signature = capabilitySignature(capabilities)
    runner.unchangedStreak = 0
  }
  if (isSettled(capabilities)) {
    return
  }
  scheduleNextProbe(runner)
}

function armNewRunner(runner: CapabilityReprobeRunner): void {
  if (isSettled(runner.readCached())) {
    clearRunnerTimer(runner)
    return
  }
  scheduleNextProbe(runner)
}

function handleWindowFocus(): void {
  const now = Date.now()
  for (const runner of runnersByOwnerKey.values()) {
    if (runner.probeInFlight || runner.timerKind !== 'ceiling') {
      continue
    }
    const demandDeadline = Math.max(now, runner.lastProbeAt + REPROBE_BASE_DELAY_MS)
    if (demandDeadline < runner.timerDeadline) {
      scheduleProbe(runner, 'ceiling', demandDeadline)
    }
  }
}

function attachFocusListener(): void {
  if (focusListenerAttached || typeof globalThis.addEventListener !== 'function') {
    return
  }
  focusListenerAttached = true
  globalThis.addEventListener('focus', handleWindowFocus)
}

function detachFocusListenerWhenIdle(): void {
  if (!focusListenerAttached || runnersByOwnerKey.size > 0) {
    return
  }
  focusListenerAttached = false
  globalThis.removeEventListener('focus', handleWindowFocus)
}

/**
 * Watch a host whose capabilities are not settled yet, and return an unregister callback.
 * Consumers of the same owner key share one backoff schedule; the last one to leave stops it.
 */
export function startWindowsTerminalCapabilityReprobe(options: {
  ownerKey: string
  probe: () => Promise<WindowsTerminalCapabilities>
  readCached: () => WindowsTerminalCapabilities
}): () => void {
  const runner: CapabilityReprobeRunner = runnersByOwnerKey.get(options.ownerKey) ?? {
    consumers: 0,
    timer: null,
    timerDeadline: 0,
    timerKind: null,
    unchangedStreak: 0,
    signature: capabilitySignature(options.readCached()),
    lastProbeAt: Date.now(),
    probeInFlight: false,
    probe: options.probe,
    readCached: options.readCached
  }
  runner.probe = options.probe
  runner.readCached = options.readCached
  runner.consumers += 1
  runnersByOwnerKey.set(options.ownerKey, runner)
  if (runner.consumers === 1) {
    armNewRunner(runner)
  }
  attachFocusListener()

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    runner.consumers -= 1
    if (runner.consumers > 0) {
      return
    }
    clearRunnerTimer(runner)
    if (runnersByOwnerKey.get(options.ownerKey) === runner) {
      runnersByOwnerKey.delete(options.ownerKey)
    }
    detachFocusListenerWhenIdle()
  }
}

export function resetWindowsTerminalCapabilityReprobeForTests(): void {
  for (const runner of runnersByOwnerKey.values()) {
    clearRunnerTimer(runner)
    runner.consumers = 0
  }
  runnersByOwnerKey.clear()
  detachFocusListenerWhenIdle()
}

import { isCodexTerminalStartupCommand } from './terminal-startup-command-classifier'

const CODEX_UPDATE_SUCCESS_TEXT = 'Update ran successfully! Please restart Codex.'
const CODEX_UPDATE_OUTPUT_TAIL_CHARS = 1024
const CODEX_RELAUNCH_FIRST_CHECK_MS = 250
const CODEX_RELAUNCH_POLL_MS = 250
const CODEX_RELAUNCH_MAX_WAIT_MS = 15_000

type CodexAutoRelaunchAfterUpdateOptions = {
  startupCommand: string | null | undefined
  getPtyId: () => string | null
  inspectForegroundProcess: (ptyId: string) => Promise<string | null>
  /** Must stay bound to the PTY current at call time; resolves false when it was not accepted. */
  sendInput: (data: string) => boolean | Promise<boolean>
  isDisposed: () => boolean
  now?: () => number
}

/**
 * Watches PTY output for the Codex self-update success message and relaunches Codex once.
 */
export type CodexAutoRelaunchAfterUpdate = {
  observeOutput: (data: string) => void
  /** Drops a pending relaunch because the PTY that printed the update notice was replaced. */
  cancelPendingRelaunch: () => void
  dispose: () => void
}

function normalizeProcessName(processName: string | null): string | null {
  if (!processName) {
    return null
  }
  const pathSegment = processName.split(/[\\/]/).at(-1) ?? processName
  return pathSegment.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Returns true when the foreground process name still appears to be a Codex CLI binary.
 */
export function isCodexForegroundProcessName(processName: string | null): boolean {
  const normalized = normalizeProcessName(processName)
  return normalized === 'codex' || normalized?.startsWith('codex-') === true
}

/**
 * Creates a terminal-output observer that resubmits the original Codex startup command after update.
 */
export function createCodexAutoRelaunchAfterUpdate(
  options: CodexAutoRelaunchAfterUpdateOptions
): CodexAutoRelaunchAfterUpdate {
  const startupCommand = options.startupCommand
  const isEligibleStartup = Boolean(startupCommand && isCodexTerminalStartupCommand(startupCommand))
  const now = options.now ?? Date.now
  let outputTail = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let observedSuccessfulUpdate = false
  let relaunched = false
  let stopped = false
  let firstObservedAt = 0
  let noticePtyId: string | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const stop = (): void => {
    stopped = true
    clearTimer()
  }

  const scheduleCheck = (delayMs: number): void => {
    if (relaunched || stopped || options.isDisposed()) {
      return
    }
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void checkForegroundAndRelaunch()
    }, delayMs)
  }

  const scheduleRetryIfWithinWindow = (): void => {
    if (now() - firstObservedAt < CODEX_RELAUNCH_MAX_WAIT_MS) {
      scheduleCheck(CODEX_RELAUNCH_POLL_MS)
    }
  }

  const checkForegroundAndRelaunch = async (): Promise<void> => {
    if (!startupCommand || relaunched || stopped || options.isDisposed()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      scheduleRetryIfWithinWindow()
      return
    }
    noticePtyId ??= ptyId
    if (ptyId !== noticePtyId) {
      // Why: a replacement PTY never printed the update notice; never type into it.
      stop()
      return
    }

    let foregroundProcess: string | null = null
    try {
      foregroundProcess = await options.inspectForegroundProcess(ptyId)
    } catch {
      // Why: an inspection miss is not proof that Codex exited; retry instead
      // of injecting a second startup command into a potentially live TUI.
      scheduleRetryIfWithinWindow()
      return
    }

    if (relaunched || stopped || options.isDisposed() || options.getPtyId() !== noticePtyId) {
      return
    }

    if (!isCodexForegroundProcessName(foregroundProcess)) {
      // Why: Codex exits after self-update instead of execing the new CLI.
      // Repeat only Orca's original Codex startup command once Codex is gone.
      relaunched = await options.sendInput(`${startupCommand}\r`)
      if (!relaunched) {
        scheduleRetryIfWithinWindow()
      }
      return
    }

    scheduleRetryIfWithinWindow()
  }

  return {
    observeOutput(data) {
      if (
        !isEligibleStartup ||
        observedSuccessfulUpdate ||
        relaunched ||
        stopped ||
        options.isDisposed()
      ) {
        return
      }
      outputTail = (outputTail + data).slice(-CODEX_UPDATE_OUTPUT_TAIL_CHARS)
      if (!outputTail.includes(CODEX_UPDATE_SUCCESS_TEXT)) {
        return
      }
      observedSuccessfulUpdate = true
      firstObservedAt = now()
      noticePtyId = options.getPtyId()
      scheduleCheck(CODEX_RELAUNCH_FIRST_CHECK_MS)
    },
    cancelPendingRelaunch() {
      if (observedSuccessfulUpdate) {
        stop()
      }
    },
    dispose() {
      stop()
    }
  }
}

/** A terminal chat's agent that is no longer running in its pane. */
export type NativeChatAgentExit = {
  /** Local clock of the observation, so later hook evidence can be ordered after it. */
  at: number
  /** The shell's report of the agent command's exit; null when the shell gave none. */
  exitCode: number | null
  /** The conversation the agent left; a restart into another one starts from scratch. */
  sessionId: string | null
  /** That conversation's transcript, which some agents need to resume it. */
  transcriptPath?: string
}

export type NativeChatAgentPresence = {
  exit: NativeChatAgentExit | null
  /** An agent came back after an exit; holds the conversation the exited one had. */
  restartFrom: { sessionId: string | null; transcriptPath?: string } | null
}

export type NativeChatAgentPresenceObservation = {
  /** The pane's shell is in the foreground again, so typed text would reach the shell. */
  agentGone: boolean
  /** Fresh evidence that an agent runs in the pane now. */
  agentRunning: boolean
  exitCode?: number | null
  sessionId: string | null
  transcriptPath?: string | null
  now: number
}

export const NATIVE_CHAT_AGENT_PRESENT: NativeChatAgentPresence = { exit: null, restartFrom: null }

/** Unknown evidence keeps the previous answer; the same answer returns the same object. */
export function nextNativeChatAgentPresence(
  previous: NativeChatAgentPresence,
  observation: NativeChatAgentPresenceObservation
): NativeChatAgentPresence {
  const exitCode = observation.exitCode ?? null
  if (observation.agentGone) {
    if (!previous.exit) {
      return {
        exit: {
          at: observation.now,
          exitCode,
          sessionId: observation.sessionId,
          ...(observation.transcriptPath ? { transcriptPath: observation.transcriptPath } : {})
        },
        restartFrom: null
      }
    }
    return previous.exit.exitCode === null && exitCode !== null
      ? { ...previous, exit: { ...previous.exit, exitCode } }
      : previous
  }
  if (previous.exit && observation.agentRunning) {
    const { sessionId, transcriptPath } = previous.exit
    return { exit: null, restartFrom: { sessionId, ...(transcriptPath ? { transcriptPath } : {}) } }
  }
  return previous
}

/** A restart is a new conversation only when both sides name theirs and the names differ. */
export function isNativeChatRestartNewConversation(
  restartFrom: NativeChatAgentPresence['restartFrom'],
  sessionId: string | null
): boolean {
  return (
    restartFrom !== null &&
    restartFrom.sessionId !== null &&
    sessionId !== null &&
    restartFrom.sessionId !== sessionId
  )
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  15: 'SIGTERM'
}

/** POSIX shells report a signal death as 128 + the signal number. */
function nativeChatAgentExitSignal(exitCode: number | null): string | null {
  return exitCode !== null && exitCode > 128 ? (SIGNAL_NAMES[exitCode - 128] ?? null) : null
}

export type NativeChatAgentExitWording =
  | { kind: 'plain' }
  | { kind: 'code'; code: number }
  | { kind: 'signal'; code: number; signal: string }
  /** SIGKILL is most often the kernel's out-of-memory killer. */
  | { kind: 'killed'; code: number }

export function nativeChatAgentExitWording(exitCode: number | null): NativeChatAgentExitWording {
  if (exitCode === null) {
    return { kind: 'plain' }
  }
  const signal = nativeChatAgentExitSignal(exitCode)
  if (signal === 'SIGKILL') {
    return { kind: 'killed', code: exitCode }
  }
  return signal ? { kind: 'signal', code: exitCode, signal } : { kind: 'code', code: exitCode }
}

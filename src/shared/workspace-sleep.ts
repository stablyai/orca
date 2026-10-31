import { hasSleptAgentToWake, type SleepingAgentSessionRecord } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'

/** A host that runs part of a workspace: this desktop's main, or a paired server. */
export type WorkspaceSleepHost = { kind: 'self' } | { kind: 'environment'; environmentId: string }

/** A workspace and the terminal/chat hosts resolved by its window. */
export type WorkspaceSleepTarget = {
  worktreeId: string
  terminalHost: WorkspaceSleepHost
  /** Every host whose chats this workspace may run; none for a directly dialed SSH place. */
  chatHosts: WorkspaceSleepHost[]
}

export type WorkspaceSleepRequest = {
  targets: WorkspaceSleepTarget[]
  /** A main-owned project move with a negotiated renderer persistence barrier. */
  projectMovePauseId?: string
  /** Only the user's Sleep hides its chats; a project move pauses through the same sleep. */
  markChatsAsleep?: boolean
}

export type WorkspaceChatStopReceipt = {
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
}

export type WorkspaceSleepOutcome = {
  worktreeId: string
  /** Why the workspace was kept open: the terminal stop's error message. */
  failure?: string
  /** The terminals and chats slept, but the workspace's VM could not be suspended and still runs. */
  vmSuspendFailure?: string
  /** A host could not confirm a chat stopped; stopped terminals stay stopped. */
  chatFailed: boolean
  receipts: WorkspaceChatStopReceipt[]
}

/** Window notifications for main-owned sleep, regardless of requester. */
export type WorkspaceSleepNotice =
  | { worktreeId: string; phase: 'started'; projectMovePauseId?: string }
  | {
      worktreeId: string
      phase: 'ended'
      projectMovePauseId?: string
      /** The terminals main proved stopped, as the window's PTY ids; null when the stop failed. */
      stoppedPtyIds: string[] | null
      slept: boolean
      /** The agents main recorded for wake, which the window reads; null when another host keeps them. */
      records: SleepingAgentSessionRecord[] | null
    }
  /** A phone or CLI's sleep that did not fully succeed; the window shows its own Sleep's toast. */
  | { worktreeId: string; phase: 'failed'; outcome: WorkspaceSleepOutcome }

/** Main resumes pane-owned sleep captures and legacy running-agent captures; the window owns completed-agent hibernation. */
export function isWorkspaceSleepRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    record.origin === 'worktree-sleep' &&
    (record.state !== 'done' || record.restoreOnTabOpenOnly === true)
  )
}

/** Whether phone open needs a window: main cannot resume window-owned hibernation records. */
export function hasWindowOnlyWakeRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string
): boolean {
  const windowWoken = Object.entries(records ?? {}).filter(
    ([, record]) => !isWorkspaceSleepRecord(record)
  )
  return hasSleptAgentToWake(Object.fromEntries(windowWoken), worktreeId)
}

/** Main wakes sleep captures; a window wakes its hibernation. A headless host cannot wake the latter. */
export function phoneWakeReport(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  hasWindow: boolean
): 'requested' | 'unsupported-headless' | 'not-applicable' {
  if (hasWindow) {
    return 'requested'
  }
  if (hasWindowOnlyWakeRecord(records, worktreeId)) {
    return 'unsupported-headless'
  }
  const mainResumes = Object.values(records ?? {}).some(
    (record) =>
      record.worktreeId === worktreeId &&
      record.origin === 'worktree-sleep' &&
      record.state !== 'done'
  )
  return mainResumes ? 'requested' : 'not-applicable'
}

/** Refusal for an automatic spawn into a worktree whose terminals the host has put to sleep. */
export const WORKTREE_TERMINALS_SLEEPING_ERROR = 'worktree_terminals_sleeping'

export function isWorktreeTerminalsSleepingError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKTREE_TERMINALS_SLEEPING_ERROR
}

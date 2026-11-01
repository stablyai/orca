import {
  createGitBashConsoleCapacityDetector,
  type GitBashConsoleCapacityDetector
} from './git-bash-console-capacity'
import type { PtyPaneStartup } from './pty-connection-types'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'

export type TerminalLaunchInputAttemptOwner = {
  readonly attempted: boolean
  record: () => void
  release: () => void
}

/** One launch keeps its observation while a remount transfers permission to record it. */
export class TerminalLaunchInputAttempt {
  private attempted = false
  private owner: object | null = null

  claim(): TerminalLaunchInputAttemptOwner {
    const owner = {}
    this.owner = owner
    const readAttempted = (): boolean => this.attempted
    return {
      get attempted() {
        return readAttempted()
      },
      record: () => {
        if (this.owner === owner) {
          this.attempted = true
        }
      },
      release: () => {
        if (this.owner === owner) {
          this.owner = null
        }
      }
    }
  }
}

export function installTerminalLaunchInputAttempt(session: ConnectPanePtySession): void {
  type ProcessExitState = {
    startup: PtyPaneStartup
    detector: GitBashConsoleCapacityDetector
    inputAttempt: TerminalLaunchInputAttemptOwner
  }
  session.pendingLaunchInputAttempt =
    session.deps.launchInputAttempt ?? new TerminalLaunchInputAttempt().claim()
  session.createProcessExitState = (startup: PtyPaneStartup): ProcessExitState => {
    session.pendingLaunchInputAttempt ??= new TerminalLaunchInputAttempt().claim()
    return {
      startup,
      detector: createGitBashConsoleCapacityDetector(),
      inputAttempt: session.pendingLaunchInputAttempt
    }
  }
  session.currentProcessExitState = session.createProcessExitState(session.paneStartup)
  session.processExitStateByPtyId = new Map<string, ProcessExitState>()
  session.bindProcessExitState = (ptyId: string, rotatedPtyId?: string): void => {
    const state: ProcessExitState | undefined = rotatedPtyId
      ? session.processExitStateByPtyId.get(rotatedPtyId)
      : session.currentProcessExitState
    if (!state) {
      return
    }
    session.processExitStateByPtyId.set(ptyId, state)
    if (state.inputAttempt === session.pendingLaunchInputAttempt) {
      session.pendingLaunchInputAttempt = null
    }
    if (rotatedPtyId && rotatedPtyId !== ptyId) {
      session.processExitStateByPtyId.delete(rotatedPtyId)
    }
  }
  session.noteTerminalInputForPty = (ptyId: string | null | undefined): void => {
    if (
      session.disposed ||
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
    ) {
      return
    }
    const inputAttempt: TerminalLaunchInputAttemptOwner | undefined =
      ptyId === null || ptyId === undefined
        ? session.pendingLaunchInputAttempt
        : session.processExitStateByPtyId.get(ptyId)?.inputAttempt
    inputAttempt?.record()
  }
}

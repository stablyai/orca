import {
  createTerminalInputEchoDelay,
  noteTerminalInputAwaitingEcho
} from '../output/terminal-input-echo-delay'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { useAppStore } from '@/store'
import { requestTerminalWritePipelineProbe } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { subscribeToTerminalUserInput } from '../../input/terminal-user-input-signal'

export function initializeTerminalInputActivityState(session: ConnectPanePtySession): void {
  session.lastTerminalInputAt = Number.NEGATIVE_INFINITY
  session.lastInteractiveRedrawInputAt = Number.NEGATIVE_INFINITY
  session.inputEchoDelay = createTerminalInputEchoDelay()
}

export function installTerminalInputActivity(session: ConnectPanePtySession): void {
  session.markTerminalInputSent = (): void => {
    session.lastTerminalInputAt = performance.now()
    session.markInteractiveRedrawInput()
  }
  session.markInteractiveRedrawInput = (): void => {
    session.lastInteractiveRedrawInputAt = performance.now()
    noteTerminalInputAwaitingEcho(session.inputEchoDelay, session.lastInteractiveRedrawInputAt)
    if (session.synchronizedForegroundOutputActive) {
      session.synchronizedForegroundFrameInteractive = true
      session.synchronizedForegroundInteractivePresentPending = true
    }
    // Why: input must probe a wedged xterm even when the PTY produces no renderer output.
    requestTerminalWritePipelineProbe(session.pane.terminal)
  }
  session.recordTerminalInputForHibernation = (): void => {
    useAppStore.getState().recordTerminalInput(session.cacheKey)
  }
  // Record real input from xterm’s core signal; onData also carries query replies that falsely prevent hibernation. Fall back only if that signal is absent.
  session.recordRealUserTerminalInput = (): void => {
    session.recordTerminalInputForHibernation()
  }
  // Why: xterm fires onUserInput before onData, so publishing here made the key wait on every store subscriber before reaching the PTY.
  session.userInputActivityDisposable = subscribeToTerminalUserInput(session.pane.terminal, () =>
    queueMicrotask(() => {
      if (!session.disposed) {
        session.recordRealUserTerminalInput()
      }
    })
  )
  session.recordTerminalInputForHibernationFallback = (): void => {
    if (session.userInputActivityDisposable === null) {
      session.recordTerminalInputForHibernation()
    }
  }
}

export function bindAcceptedTerminalInputActivity(session: ConnectPanePtySession): void {
  session.markAcceptedTerminalInputSent = (): void => {
    session.markTerminalInputSent()
    session.recordTerminalInputForHibernationFallback()
  }
}

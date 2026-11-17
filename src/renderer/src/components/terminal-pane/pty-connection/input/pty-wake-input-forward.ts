import { useAppStore } from '@/store/index'
import {
  captureWakeInput,
  hasWakeInput,
  noteUserInputForPane,
  rebindWakeInputTarget
} from '../../input/wake-input-buffer'
import { registerWakePane } from '../../input/wake-pane-attach'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { findColdRestoreResumeSource } from '../startup/cold-restore-resume-startup'
import { isAttachedForWakeInput } from './wake-input-attached'

export type PaneWakeInput = {
  /** True when the keystroke was held for a waking workspace instead of forwarded now. */
  capture: (data: string, wasUserInput: boolean) => boolean
  /** Wraps the pane's input subscription so disposing it also unregisters the waking pane. */
  wrapDisposable: (inputData: { dispose: () => void }) => { dispose: () => void }
}

/** Holds typing into a workspace whose cloud server is waking until this pane is attached again. */
export function installPaneWakeInput(
  session: ConnectPanePtySession,
  forwardUserInput: (data: string) => void
): PaneWakeInput {
  // The layout leaf outlives a remount, so held typing finds this pane's newest session.
  const wakeInputKey = session.pane.leafId ?? String(session.pane.id)
  // Held typing goes in only once the pane is attached to the woken terminal (isAttachedForWakeInput).
  const wakeInputReady = (): boolean =>
    !session.disposed &&
    isAttachedForWakeInput(session.deps.paneTransportsRef.current.get(session.pane.id))
  rebindWakeInputTarget(session.deps.worktreeId, wakeInputKey, forwardUserInput, wakeInputReady)
  // The waking pill stays until the pane in front is attached again (it can take keys then).
  const unregisterWakePane = registerWakePane(session.deps.worktreeId, wakeInputKey, {
    // Input reaches the terminal: attached to one, and nothing typed into it still unsent (a pane
    // that looks connected but drops input stays "Connecting…" and then fails visibly).
    isReady: wakeInputReady,
    retry: () => {
      const transport = session.deps.paneTransportsRef.current.get(session.pane.id)
      return Boolean(transport?.retryRecovery?.() || transport?.reopenAfterHostReturned?.())
    },
    isActive: () =>
      !session.disposed &&
      Boolean(session.deps.isActiveRef.current) &&
      session.manager.getActivePane()?.id === session.pane.id
  })
  // Typing is only held for shell panes: a woken agent pane relaunches the agent, and text typed
  // for the old screen must not become its prompt.
  const isAgentPane = (): boolean => {
    const state = useAppStore.getState()
    return (
      state.agentStatusByPaneKey?.get(session.cacheKey) !== undefined ||
      findColdRestoreResumeSource(session, state) !== null
    )
  }
  return {
    capture: (data, wasUserInput) => {
      if (wasUserInput) {
        noteUserInputForPane(wakeInputKey, Date.now(), session.deps.worktreeId)
      }
      // Typing into a workspace whose server is waking is accepted now and delivered, in order,
      // once this pane is attached to the woken terminal.
      return (
        wasUserInput &&
        hasWakeInput(session.deps.worktreeId) &&
        !isAgentPane() &&
        captureWakeInput(
          session.deps.worktreeId,
          wakeInputKey,
          data,
          forwardUserInput,
          wakeInputReady
        )
      )
    },
    wrapDisposable: (inputData) => ({
      dispose: () => {
        unregisterWakePane()
        inputData.dispose()
      }
    })
  }
}

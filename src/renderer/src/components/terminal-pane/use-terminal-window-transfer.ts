import { useEffect, useState } from 'react'
import type {
  TerminalWindowContext,
  TerminalWindowTransferAck,
  TerminalWindowTransferCommand
} from '../../../../shared/terminal-window-transfer'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import { useAppStore } from '@/store'
import { ensurePtyDispatcher } from './pty-dispatcher'

function waitForWorkspaceSession(): Promise<void> {
  const ready = (): boolean => {
    const state = useAppStore.getState()
    return state.workspaceSessionReady && state.hydrationSucceeded
  }
  if (ready()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const unsubscribe = useAppStore.subscribe(() => {
      if (ready()) {
        unsubscribe()
        resolve()
      }
    })
  })
}

export async function executeTerminalWindowTransferCommand(
  command: TerminalWindowTransferCommand
): Promise<TerminalWindowTransferAck> {
  await waitForWorkspaceSession()
  const state = useAppStore.getState()
  const needsSeed = command.phase === 'target-import' || command.phase === 'source-restore'
  if (needsSeed && !command.seed) {
    throw new Error('terminal_transfer_seed_missing')
  }
  const ok = needsSeed
    ? state.importTransferredTerminalTab(command.seed!)
    : state.removeTransferredTerminalTab(command.tabId)
  if (!ok) {
    throw new Error(`terminal_transfer_${command.phase}_rejected`)
  }
  const fresh = useAppStore.getState()
  await persistWorkspaceSessionByHost(
    window.api.session,
    buildWorkspaceSessionPayload(fresh),
    fresh
  )
  return {
    transferId: command.transferId,
    tabId: command.tabId,
    phase: command.phase,
    ok: true,
    empty: Object.values(fresh.unifiedTabsByWorktree).every((tabs) => tabs.length === 0)
  }
}

export function useTerminalWindowTransfer(): TerminalWindowContext | null {
  const [context, setContext] = useState<TerminalWindowContext | null>(null)

  useEffect(() => {
    ensurePtyDispatcher()
    const unsubscribe = window.api.terminalWindow.onCommand((command) => {
      void executeTerminalWindowTransferCommand(command).then(
        (ack) => window.api.terminalWindow.ack(ack),
        (error) =>
          window.api.terminalWindow.ack({
            transferId: command.transferId,
            tabId: command.tabId,
            phase: command.phase,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      )
    })
    void window.api.terminalWindow.getContext().then(setContext)
    return unsubscribe
  }, [])

  return context
}

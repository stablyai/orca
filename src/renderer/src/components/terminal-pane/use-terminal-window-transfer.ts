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

function waitForWorkspaceSession(signal?: AbortSignal): Promise<boolean> {
  const ready = (): boolean => {
    const state = useAppStore.getState()
    return state.workspaceSessionReady && state.hydrationSucceeded
  }
  if (ready()) {
    return Promise.resolve(true)
  }
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = (): void => undefined
    const finish = (isReady: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(isReady)
    }
    const onAbort = (): void => finish(false)
    unsubscribe = useAppStore.subscribe(() => {
      if (ready()) {
        finish(true)
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      finish(false)
    } else if (ready()) {
      finish(true)
    }
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
  const ok =
    command.phase === 'target-import'
      ? state.importTransferredTerminalTab(command.seed!)
      : command.phase === 'source-restore'
        ? state.restoreTransferredTerminalTab(command.seed!)
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
    const hydration = new AbortController()
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
    void waitForWorkspaceSession(hydration.signal).then(async (ready) => {
      if (!ready || hydration.signal.aborted) {
        return
      }
      const nextContext = await window.api.terminalWindow.getContext()
      if (!hydration.signal.aborted) {
        setContext(nextContext)
      }
    })
    return () => {
      hydration.abort()
      unsubscribe()
    }
  }, [])

  return context
}

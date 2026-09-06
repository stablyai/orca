import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: when multiple panes/tabs need the same deferred SSH connection,
// the first one calls ssh.connect() and subsequent ones must wait for it
// rather than returning early (which would leave them disconnected). This
// helper either connects or waits for an in-flight connect to finish.
export type SshConnectResult = { connected: true } | { connected: false; error: string }
type UserInitiatedSshConnectOutcome = 'connected' | 'cancelled' | 'failed'

const sshConnectPromises = new Map<string, Promise<SshConnectResult>>()

function sshPromptConnectOutcomeForStatus(
  status: string | undefined,
  sawNonDisconnected: boolean
): UserInitiatedSshConnectOutcome | null {
  if (status === 'connected') {
    return 'connected'
  }
  if (status === 'auth-failed' || status === 'error' || status === 'reconnection-failed') {
    return 'failed'
  }
  // Why: this only counts after a real connect attempt; the entry-time
  // disconnected state just means the user still needs to initiate auth.
  if (sawNonDisconnected && status === 'disconnected') {
    return 'cancelled'
  }
  return null
}

export function waitForUserInitiatedSshConnect(
  session: ConnectPanePtySession
): Promise<UserInitiatedSshConnectOutcome> {
  return new Promise((resolve) => {
    // Entry-time disconnected means authentication has not started; it only cancels after another status was observed.
    let sawNonDisconnected = !['disconnected', undefined].includes(
      useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status
    )
    let settled = false
    const finish = (outcome: UserInitiatedSshConnectOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe()
      const index = session.waitTeardowns.indexOf(teardown)
      if (index !== -1) {
        session.waitTeardowns.splice(index, 1)
      }
      resolve(outcome)
    }
    const teardown = (): void => finish('cancelled')
    // Disposal must resolve the wait even if the SSH store never emits again.
    session.waitTeardowns.push(teardown)
    const readOutcome = (status: string | undefined): UserInitiatedSshConnectOutcome | null => {
      if (status && status !== 'disconnected') {
        sawNonDisconnected = true
      }
      return sshPromptConnectOutcomeForStatus(status, sawNonDisconnected)
    }
    const unsubscribe = useAppStore.subscribe((state) => {
      if (session.disposed) {
        finish('cancelled')
        return
      }
      const outcome = readOutcome(state.sshConnectionStates.get(session.connectionId)?.status)
      if (outcome) {
        finish(outcome)
      }
    })
    if (session.disposed) {
      finish('cancelled')
      return
    }
    // Catch a status change that landed between the caller's check and this subscription.
    const currentOutcome = readOutcome(
      useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status
    )
    if (currentOutcome) {
      finish(currentOutcome)
    }
  })
}

export async function waitForSshConnection(connectionId: string): Promise<SshConnectResult> {
  const state = useAppStore.getState().sshConnectionStates.get(connectionId)
  if (state?.status === 'connected') {
    return { connected: true }
  }

  const existing = sshConnectPromises.get(connectionId)
  if (existing) {
    return existing
  }

  const promise: Promise<SshConnectResult> = (async (): Promise<SshConnectResult> => {
    try {
      await window.api.ssh.connect({ targetId: connectionId })
      return { connected: true }
    } catch (err) {
      console.warn(`Deferred SSH reconnect failed for ${connectionId}:`, err)
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      sshConnectPromises.delete(connectionId)
    }
  })()

  sshConnectPromises.set(connectionId, promise)
  return promise
}

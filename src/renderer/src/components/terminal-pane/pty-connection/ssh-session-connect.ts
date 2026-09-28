import { useAppStore } from '@/store'
import type { SshConnectionState } from '../../../../../shared/ssh-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: when multiple panes/tabs need the same deferred SSH connection,
// the first one calls ssh.ensureConnected() and subsequent ones must wait for it
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
  // Entry-time disconnected means authentication has not started; it only cancels after another status was observed.
  let sawNonDisconnected = !['disconnected', undefined].includes(
    useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status
  )
  return waitForPublishedSshOutcome(session, (state) => {
    const status = state?.status
    if (status && status !== 'disconnected') {
      sawNonDisconnected = true
    }
    return sshPromptConnectOutcomeForStatus(status, sawNonDisconnected)
  })
}

// Resolves once `readOutcome` answers for the pane's published SSH state, or 'cancelled' on disposal.
function waitForPublishedSshOutcome(
  session: ConnectPanePtySession,
  readOutcome: (state: SshConnectionState | undefined) => UserInitiatedSshConnectOutcome | null
): Promise<UserInitiatedSshConnectOutcome> {
  return new Promise((resolve) => {
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
    const unsubscribe = useAppStore.subscribe((state) => {
      if (session.disposed) {
        finish('cancelled')
        return
      }
      const outcome = readOutcome(state.sshConnectionStates.get(session.connectionId))
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
      useAppStore.getState().sshConnectionStates.get(session.connectionId)
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
      await window.api.ssh.ensureConnected({ targetId: connectionId })
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

// Why ask main when the store is silent: the refusal can reach this pane before the push that
// publishes the Disconnect, and the host's own answer is the fact either way.
async function isSshHostHeldDownByUser(connectionId: string): Promise<boolean> {
  if (useAppStore.getState().sshConnectionStates.get(connectionId)?.disconnectedBy === 'user') {
    return true
  }
  try {
    const published = await window.api.ssh.getState({ targetId: connectionId })
    return published?.disconnectedBy === 'user'
  } catch {
    return false
  }
}

/**
 * Waits on a host the user's Disconnect holds down until the user's own Connect succeeds or
 * fails. Only those, or the pane closing, end it: nothing else reattaches this pane once its
 * connect gave up, so a Connect abandoned before it finished keeps the pane waiting.
 */
function waitForUserConnectOfHeldDownHost(
  session: ConnectPanePtySession
): Promise<UserInitiatedSshConnectOutcome> {
  const entryState = useAppStore.getState().sshConnectionStates.get(session.connectionId)
  return waitForPublishedSshOutcome(session, (state) => {
    if (state?.disconnectedBy === 'user') {
      return null
    }
    const outcome = sshPromptConnectOutcomeForStatus(state?.status, false)
    // Why skip the entry state's failure: it was published before this pane waited, so it is
    // not the outcome of the user's Connect (the refusal can beat the Disconnect's push).
    return outcome === 'failed' && state === entryState ? null : outcome
  })
}

/**
 * Connects the pane's host, unless the user's own Disconnect holds it down: then the pane
 * reports nothing and dials nothing, and waits for the user to connect it again. Decided from
 * the published state, not the error, because a connect already in flight when the user
 * disconnects fails as a cancellation.
 */
export async function connectPaneSshHost(
  session: ConnectPanePtySession
): Promise<SshConnectResult | 'cancelled'> {
  const result = await waitForSshConnection(session.connectionId)
  if (result.connected || session.disposed) {
    return result
  }
  if (!(await isSshHostHeldDownByUser(session.connectionId))) {
    return result
  }
  const outcome = await waitForUserConnectOfHeldDownHost(session)
  if (outcome === 'connected') {
    return { connected: true }
  }
  if (outcome === 'failed') {
    const published = useAppStore.getState().sshConnectionStates.get(session.connectionId)
    return { connected: false, error: published?.error ?? published?.status ?? 'unknown error' }
  }
  return 'cancelled'
}

import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type {
  PortForwardEntry,
  UnrestoredPortForward
} from '../../../../shared/remote-runtime/ssh/ssh-types'
import {
  getClientForEnvironment,
  requireActiveEnvironmentOrNull
} from '../runtime/client/web-runtime-session'

type SshCredentialRequest = {
  type: 'sshCredentialRequest'
  requestId: string
  targetId: string
  kind: 'keyboard-interactive' | 'passphrase' | 'password'
  detail: string
  echo?: boolean
}
type SshCredentialResolved = { type: 'sshCredentialResolved'; requestId: string }
type SshPortForwardsChanged = {
  type: 'sshPortForwardsChanged'
  targetId: string
  forwards: PortForwardEntry[]
  unrestored?: UnrestoredPortForward[]
}
type SshStateChanged = Extract<RuntimeClientEvent, { type: 'sshStateChanged' }>
type SshStreamEvent =
  | SshCredentialRequest
  | SshCredentialResolved
  | SshPortForwardsChanged
  | SshStateChanged

const sshCredentialRequestListeners = new Set<(request: SshCredentialRequest) => void>()
const sshCredentialResolvedListeners = new Set<(resolved: SshCredentialResolved) => void>()
const sshPortForwardsChangedListeners = new Set<(change: SshPortForwardsChanged) => void>()
const sshStateChangedListeners = new Set<(change: SshStateChanged) => void>()
let sshRuntimeEventSubscription: { unsubscribe: () => void; abort: AbortController } | null = null
let sshRuntimeEventSubscriptionPromise: Promise<void> | null = null
let sshRuntimeEventRetryTimer: ReturnType<typeof setTimeout> | null = null

function hasSshRuntimeEventListeners(): boolean {
  return (
    sshCredentialRequestListeners.size > 0 ||
    sshCredentialResolvedListeners.size > 0 ||
    sshPortForwardsChangedListeners.size > 0 ||
    sshStateChangedListeners.size > 0
  )
}

function deliverSshRuntimeEvent(response: RuntimeRpcResponse<unknown>): void {
  if (!response.ok) {
    scheduleSshRuntimeEventSubscription()
    return
  }
  const message = response.result as SshStreamEvent
  if (message.type === 'sshCredentialRequest') {
    for (const listener of sshCredentialRequestListeners) {
      listener(message)
    }
  } else if (message.type === 'sshCredentialResolved') {
    for (const listener of sshCredentialResolvedListeners) {
      listener(message)
    }
  } else if (message.type === 'sshPortForwardsChanged') {
    for (const listener of sshPortForwardsChangedListeners) {
      listener(message)
    }
  } else if (message.type === 'sshStateChanged') {
    for (const listener of sshStateChangedListeners) {
      listener(message)
    }
  }
}

function scheduleSshRuntimeEventSubscription(): void {
  if (sshRuntimeEventRetryTimer || !hasSshRuntimeEventListeners()) {
    return
  }
  sshRuntimeEventRetryTimer = setTimeout(() => {
    sshRuntimeEventRetryTimer = null
    ensureSshRuntimeEventSubscription()
  }, 500)
}

function ensureSshRuntimeEventSubscription(): void {
  if (
    sshRuntimeEventSubscription ||
    sshRuntimeEventSubscriptionPromise ||
    !hasSshRuntimeEventListeners()
  ) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return
  }
  const abort = new AbortController()
  sshRuntimeEventSubscriptionPromise = getClientForEnvironment(environment)
    .subscribe(
      'runtime.clientEvents.subscribe',
      null,
      {
        onResponse: deliverSshRuntimeEvent,
        onError: () => scheduleSshRuntimeEventSubscription(),
        onClose: () => {
          sshRuntimeEventSubscription = null
          scheduleSshRuntimeEventSubscription()
        }
      },
      { signal: abort.signal }
    )
    .then((subscription) => {
      sshRuntimeEventSubscriptionPromise = null
      if (abort.signal.aborted || !hasSshRuntimeEventListeners()) {
        subscription.unsubscribe()
        return
      }
      sshRuntimeEventSubscription = { unsubscribe: subscription.unsubscribe, abort }
    })
    .catch(() => {
      sshRuntimeEventSubscriptionPromise = null
      scheduleSshRuntimeEventSubscription()
    })
}

function releaseSshRuntimeEventSubscriptionIfUnused(): void {
  if (hasSshRuntimeEventListeners()) {
    return
  }
  if (sshRuntimeEventRetryTimer) {
    clearTimeout(sshRuntimeEventRetryTimer)
    sshRuntimeEventRetryTimer = null
  }
  sshRuntimeEventSubscription?.abort.abort()
  sshRuntimeEventSubscription?.unsubscribe()
  sshRuntimeEventSubscription = null
}

export function onSshCredentialRequest(
  listener: (request: SshCredentialRequest) => void
): () => void {
  sshCredentialRequestListeners.add(listener)
  ensureSshRuntimeEventSubscription()
  return () => {
    sshCredentialRequestListeners.delete(listener)
    releaseSshRuntimeEventSubscriptionIfUnused()
  }
}

export function onSshCredentialResolved(
  listener: (resolved: SshCredentialResolved) => void
): () => void {
  sshCredentialResolvedListeners.add(listener)
  ensureSshRuntimeEventSubscription()
  return () => {
    sshCredentialResolvedListeners.delete(listener)
    releaseSshRuntimeEventSubscriptionIfUnused()
  }
}

export function onSshPortForwardsChanged(
  listener: (change: SshPortForwardsChanged) => void
): () => void {
  sshPortForwardsChangedListeners.add(listener)
  ensureSshRuntimeEventSubscription()
  return () => {
    sshPortForwardsChangedListeners.delete(listener)
    releaseSshRuntimeEventSubscriptionIfUnused()
  }
}

export function onSshStateChanged(listener: (change: SshStateChanged) => void): () => void {
  sshStateChangedListeners.add(listener)
  ensureSshRuntimeEventSubscription()
  return () => {
    sshStateChangedListeners.delete(listener)
    releaseSshRuntimeEventSubscriptionIfUnused()
  }
}

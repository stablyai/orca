// Classic SSH hosts' agent sign-in, as the panel and S3 show it: the last report per host (so a
// disconnected host shows its dated last check) and any code sign-in running there. Main asks the
// host only while it's connected; nothing here connects.
import { useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import type {
  SshAgentSignInFlow,
  SshAgentSignInReport,
  SshAgentSignInStatusResult
} from '../../../../shared/ssh-agent-sign-in-types'

type HostState = {
  report: SshAgentSignInReport | null
  /** The last ask found the host disconnected or silent. */
  failed: boolean
  flows: Partial<Record<HostAgentSignInAgent, SshAgentSignInFlow>>
}

const EMPTY: HostState = { report: null, failed: false, flows: {} }
const hosts = new Map<string, HostState>()
const listeners = new Set<() => void>()
let listening = false

function api() {
  return typeof window === 'undefined' ? null : (window.api?.sshAgentSignIn ?? null)
}

function set(targetId: string, patch: Partial<HostState>): void {
  hosts.set(targetId, { ...(hosts.get(targetId) ?? EMPTY), ...patch })
  for (const listener of listeners) {
    listener()
  }
}

function listen(): void {
  if (listening) {
    return
  }
  const bridge = api()
  if (!bridge) {
    return
  }
  listening = true
  bridge.onFlowChanged((flow) => {
    const current = hosts.get(flow.targetId) ?? EMPTY
    set(flow.targetId, { flows: { ...current.flows, [flow.agent]: flow } })
    if (flow.phase === 'signedIn') {
      void refreshSshAgentReport(flow.targetId, true)
    }
  })
}

function subscribe(listener: () => void): () => void {
  listen()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeNothing(): () => void {
  return () => {}
}

export function readSshAgentState(targetId: string): HostState {
  return hosts.get(targetId) ?? EMPTY
}

export function useSshAgentState(targetId: string | null): HostState {
  // Only an SSH host listens for sign-in flows; other hosts never touch the bridge.
  return useSyncExternalStore(
    targetId ? subscribe : subscribeNothing,
    () => (targetId ? readSshAgentState(targetId) : EMPTY),
    () => EMPTY
  )
}

function apply(
  targetId: string,
  result: SshAgentSignInStatusResult | null
): SshAgentSignInReport | null {
  if (result?.ok) {
    set(targetId, { report: result.report, failed: false })
    return result.report
  }
  set(targetId, { failed: true })
  return null
}

/** Asks main; main answers `disconnected` without connecting when the host isn't connected. */
export async function refreshSshAgentReport(
  targetId: string,
  force = false
): Promise<SshAgentSignInReport | null> {
  listen()
  const bridge = api()
  if (!bridge) {
    return null
  }
  return apply(targetId, await bridge.status({ targetId, force }).catch(() => null))
}

export async function startSshAgentSignIn(
  targetId: string,
  agent: HostAgentSignInAgent
): Promise<void> {
  listen()
  const flow = await api()
    ?.start({ targetId, agent })
    .catch(() => null)
  if (flow) {
    const current = readSshAgentState(targetId)
    set(targetId, { flows: { ...current.flows, [agent]: flow } })
  }
}

export function submitSshAgentSignInCode(flowId: string, code: string): Promise<boolean> {
  return (
    api()
      ?.submitCode({ flowId, code })
      .catch(() => false) ?? Promise.resolve(false)
  )
}

export function cancelSshAgentSignIn(flowId: string): void {
  void api()
    ?.cancel({ flowId })
    .catch(() => undefined)
}

export async function signOutSshAgent(
  targetId: string,
  agent: HostAgentSignInAgent
): Promise<void> {
  apply(
    targetId,
    (await api()
      ?.signOut({ targetId, agent })
      .catch(() => null)) ?? null
  )
}

/** Fixtures and tests only. */
export function setSshAgentStateForTest(targetId: string, state: Partial<HostState>): void {
  set(targetId, state)
}

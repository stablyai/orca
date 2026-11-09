import { useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import {
  hostAgentSignInEntry,
  readHostAgentSignInReport,
  refreshHostAgentSignInReport
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'

/** What the sign-in card shows; one step at a time, in the order the person meets them. */
export type AgentSignInGateView =
  | { step: 'need' }
  | { step: 'starting' }
  | { step: 'waiting'; url: string }
  | { step: 'paste'; url: string; submitting: boolean; refusal: string | null }
  | { step: 'device'; url: string; userCode: string }
  | { step: 'signed'; email: string | null }
  | {
      step: 'error'
      kind: 'port_busy' | 'timeout' | 'declined' | 'offline' | 'failed'
      message: string
      port?: number
    }

export type AgentSignInGate = {
  /** One gate per host and agent; every pane launching that agent there waits on it. */
  key: string
  environmentId: string
  hostLabel: string
  agent: HostAgentSignInAgent
  prompt: string | null
  /** The host predates browser sign-in, so its sign-in pastes a code or uses a device code. */
  codeOnly: boolean
  view: AgentSignInGateView
}

export type GateEntry = AgentSignInGate & {
  /** Each held pane's launch, by pane key. */
  waiters: Map<string, (outcome: 'proceed' | 'cancel') => void>
  /** Bumps on every new sign-in attempt so a late result of an abandoned one is ignored. */
  attempt: number
  forwardFlowId: string | null
}

// A first check on a host may spawn its CLIs; past this the launch proceeds unheld.
const FIRST_CHECK_BUDGET_MS = 4_000

const gates = new Map<string, GateEntry>()
const gateKeyByPane = new Map<string, string>()
const listeners = new Set<() => void>()

const gateKeyOf = (environmentId: string, agent: HostAgentSignInAgent): string =>
  `${environmentId}\u0000${agent}`

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function publicGate(entry: GateEntry): AgentSignInGate {
  const { waiters: _waiters, attempt: _attempt, forwardFlowId: _flow, ...gate } = entry
  return gate
}

const snapshots = new WeakMap<GateEntry, { view: AgentSignInGateView; gate: AgentSignInGate }>()
function snapshotOf(entry: GateEntry | undefined): AgentSignInGate | null {
  if (!entry) {
    return null
  }
  const cached = snapshots.get(entry)
  if (cached && cached.view === entry.view) {
    return cached.gate
  }
  const gate = publicGate(entry)
  snapshots.set(entry, { view: entry.view, gate })
  return gate
}

/** The gate the pane's launch waits on. */
export function agentSignInGateEntry(paneKey: string): GateEntry | undefined {
  const key = gateKeyByPane.get(paneKey)
  return key === undefined ? undefined : gates.get(key)
}

export function isCurrentAgentSignInGate(entry: GateEntry): boolean {
  return gates.get(entry.key) === entry
}

export function setAgentSignInGateView(entry: GateEntry, view: AgentSignInGateView): void {
  if (!isCurrentAgentSignInGate(entry)) {
    return
  }
  entry.view = view
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAgentSignInGate(paneKey: string): AgentSignInGate | null {
  return useSyncExternalStore(subscribe, () => snapshotOf(agentSignInGateEntry(paneKey)))
}

export function readAgentSignInGate(paneKey: string): AgentSignInGate | null {
  return snapshotOf(agentSignInGateEntry(paneKey))
}

/** Whether `agent` is known signed out on the host; unknown answers count as signed in. */
export async function isAgentSignedOutOnHost(
  environmentId: string,
  agent: HostAgentSignInAgent
): Promise<boolean> {
  const cached = hostAgentSignInEntry(readHostAgentSignInReport(environmentId), agent)
  if (cached && cached.state !== 'signedOut') {
    // Sign-in rarely changes by itself; refresh quietly for next time.
    void refreshHostAgentSignInReport(environmentId)
    return false
  }
  const report = await Promise.race([
    refreshHostAgentSignInReport(environmentId),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_CHECK_BUDGET_MS))
  ])
  return hostAgentSignInEntry(report, agent)?.state === 'signedOut'
}

function waitOn(entry: GateEntry, paneKey: string): Promise<'proceed' | 'cancel'> {
  return new Promise((resolve) => {
    const previous = entry.waiters.get(paneKey)
    entry.waiters.set(paneKey, (outcome) => {
      previous?.(outcome)
      resolve(outcome)
    })
    gateKeyByPane.set(paneKey, entry.key)
    notify()
  })
}

/**
 * Holds an agent launch on a runtime host until its agent is signed in there. Resolves `proceed`
 * at once when the host reports it signed in, cannot tell, or predates the check. Panes launching
 * the same agent on the same host share one sign-in.
 */
export async function requireAgentSignIn(request: {
  key: string
  environmentId: string
  hostLabel: string
  agent: HostAgentSignInAgent
  prompt: string | null
}): Promise<'proceed' | 'cancel'> {
  const { key: paneKey, ...gate } = request
  const key = gateKeyOf(gate.environmentId, gate.agent)
  const running = gates.get(key)
  if (running) {
    return waitOn(running, paneKey)
  }
  if (!(await isAgentSignedOutOnHost(gate.environmentId, gate.agent))) {
    return 'proceed'
  }
  const codeOnly = !(await runtimeEnvironmentSupportsCapability(
    gate.environmentId,
    HOST_ACCOUNT_SIGN_IN_CALLBACK_RUNTIME_CAPABILITY
  ).catch(() => false))
  const entry = gates.get(key) ?? {
    ...gate,
    key,
    codeOnly,
    view: { step: 'need' as const },
    waiters: new Map(),
    attempt: 0,
    forwardFlowId: null
  }
  gates.set(key, entry)
  return waitOn(entry, paneKey)
}

/** Ends the gate for every pane waiting on it. */
export function settleAgentSignInGate(entry: GateEntry, outcome: 'proceed' | 'cancel'): void {
  if (!isCurrentAgentSignInGate(entry)) {
    return
  }
  closeAgentSignInForward(entry)
  gates.delete(entry.key)
  const waiters = [...entry.waiters]
  entry.waiters.clear()
  for (const [paneKey] of waiters) {
    gateKeyByPane.delete(paneKey)
  }
  notify()
  for (const [, resolve] of waiters) {
    resolve(outcome)
  }
}

/** Lets one pane go its own way; true when no other pane still waits on the gate. */
export function releaseAgentSignInPane(paneKey: string, outcome: 'proceed' | 'cancel'): boolean {
  const entry = agentSignInGateEntry(paneKey)
  const resolve = entry?.waiters.get(paneKey)
  if (!entry || !resolve) {
    return true
  }
  entry.waiters.delete(paneKey)
  gateKeyByPane.delete(paneKey)
  notify()
  resolve(outcome)
  return entry.waiters.size === 0
}

export function closeAgentSignInForward(entry: GateEntry): void {
  const flowId = entry.forwardFlowId
  if (!flowId) {
    return
  }
  entry.forwardFlowId = null
  void window.api.runtimeEnvironments.closeAuthCallbackForward?.({
    environmentId: entry.environmentId,
    flowId
  })
}

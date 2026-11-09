import { useSyncExternalStore } from 'react'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import {
  agentSignInGateEntry,
  readAgentSignInGate,
  requireAgentSignIn,
  subscribeAgentSignInGates,
  type AgentSignInGateView
} from './agent-sign-in-gate-store'
import { cancelAgentSignIn, startAgentSignIn } from './agent-sign-in-gate'

/** One agent the sheet signed in, and the account this computer uses when the host's differs. */
export type VmBuildSignedInAgent = {
  agent: HostAgentSignInAgent
  email: string | null
  expectedEmail?: string
}

/** The build sheet's "Sign in Claude + Codex" run: one agent at a time, in the order given. */
export type VmBuildAgentSignIn = {
  environmentId: string
  running: boolean
  current: HostAgentSignInAgent | null
  next: readonly HostAgentSignInAgent[]
  signedIn: readonly VmBuildSignedInAgent[]
}

const runs = new Map<string, VmBuildAgentSignIn>()
const stopped = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function update(creationId: string, patch: Partial<VmBuildAgentSignIn>): void {
  const run = runs.get(creationId)
  if (run) {
    runs.set(creationId, { ...run, ...patch })
    notify()
  }
}

/** The gate key the sheet waits under; it has no pane, so it never holds a launch. */
export function vmBuildSignInKey(creationId: string): string {
  return `vm-build-sheet:${creationId}`
}

/** Resolves once the sign-in for this key exists, or the wait ended without needing one. */
function gateOpened(key: string, held: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    const done = (): void => {
      unsubscribe()
      resolve()
    }
    unsubscribe = subscribeAgentSignInGates(() => {
      if (agentSignInGateEntry(key)) {
        done()
      }
    })
    if (agentSignInGateEntry(key)) {
      done()
    }
    void held.finally(done)
  })
}

async function signInOne(
  creationId: string,
  environmentId: string,
  hostLabel: string,
  agent: HostAgentSignInAgent
): Promise<'proceed' | 'cancel'> {
  const key = vmBuildSignInKey(creationId)
  let lastView: AgentSignInGateView | null = null
  const unsubscribe = subscribeAgentSignInGates(() => {
    lastView = readAgentSignInGate(key)?.view ?? lastView
  })
  try {
    const held = requireAgentSignIn({
      key,
      environmentId,
      hostLabel,
      agent,
      prompt: null,
      background: true
    })
    await gateOpened(key, held)
    if (stopped.has(creationId)) {
      cancelAgentSignIn(key)
    } else if (agentSignInGateEntry(key)?.view.step === 'need') {
      // A pane may already be signing this agent in there; the sheet then only follows it.
      startAgentSignIn(key)
    }
    const outcome = await held
    const signed = lastView as AgentSignInGateView | null
    if (outcome === 'proceed' && signed?.step === 'signed') {
      const run = runs.get(creationId)
      update(creationId, {
        signedIn: [
          ...(run?.signedIn ?? []),
          {
            agent,
            email: signed.email,
            ...(signed.expectedEmail ? { expectedEmail: signed.expectedEmail } : {})
          }
        ]
      })
    }
    return outcome
  } finally {
    unsubscribe()
  }
}

/** Signs each agent in on the VM back to back: one browser approval, then the next. */
export async function startVmBuildAgentSignIn(
  creationId: string,
  environmentId: string,
  hostLabel: string,
  agents: readonly HostAgentSignInAgent[]
): Promise<void> {
  if (runs.get(creationId)?.running || agents.length === 0) {
    return
  }
  stopped.delete(creationId)
  runs.set(creationId, {
    environmentId,
    running: true,
    current: null,
    next: agents,
    signedIn: runs.get(creationId)?.signedIn ?? []
  })
  notify()
  for (const [index, agent] of agents.entries()) {
    if (stopped.has(creationId)) {
      break
    }
    update(creationId, { current: agent, next: agents.slice(index + 1) })
    if ((await signInOne(creationId, environmentId, hostLabel, agent)) === 'cancel') {
      break
    }
  }
  update(creationId, { running: false, current: null, next: [] })
}

/** Stops the run; a pane still waiting on the same sign-in keeps it. */
export function cancelVmBuildAgentSignIn(creationId: string): void {
  stopped.add(creationId)
  update(creationId, { next: [] })
  cancelAgentSignIn(vmBuildSignInKey(creationId))
}

/** Forgets an agent the sheet signed in, e.g. after switching its account on the host. */
export function forgetVmBuildSignedInAgent(creationId: string, agent: HostAgentSignInAgent): void {
  const run = runs.get(creationId)
  if (run) {
    update(creationId, { signedIn: run.signedIn.filter((entry) => entry.agent !== agent) })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVmBuildAgentSignIn(creationId: string): VmBuildAgentSignIn | null {
  return useSyncExternalStore(subscribe, () => runs.get(creationId) ?? null)
}

export function _resetVmBuildAgentSignInForTest(): void {
  runs.clear()
  stopped.clear()
  listeners.clear()
}

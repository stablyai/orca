import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
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
  /** The gate key this run waits under; it has no pane, so it never holds a launch. */
  gateKey: string
  running: boolean
  current: HostAgentSignInAgent | null
  next: readonly HostAgentSignInAgent[]
  signedIn: readonly VmBuildSignedInAgent[]
}

const runs = new Map<string, VmBuildAgentSignIn>()
const listeners = new Set<() => void>()
let generation = 0

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function isCurrentRun(creationId: string, gateKey: string): boolean {
  return runs.get(creationId)?.gateKey === gateKey
}

function update(creationId: string, gateKey: string, patch: Partial<VmBuildAgentSignIn>): void {
  const run = runs.get(creationId)
  if (run && run.gateKey === gateKey) {
    runs.set(creationId, { ...run, ...patch })
    notify()
  }
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
  gateKey: string,
  hostLabel: string,
  agent: HostAgentSignInAgent
): Promise<'proceed' | 'cancel'> {
  const environmentId = runs.get(creationId)!.environmentId
  let lastView: AgentSignInGateView | null = null
  const unsubscribe = subscribeAgentSignInGates(() => {
    lastView = readAgentSignInGate(gateKey)?.view ?? lastView
  })
  try {
    const held = requireAgentSignIn({
      key: gateKey,
      environmentId,
      hostLabel,
      agent,
      prompt: null,
      background: true
    })
    await gateOpened(gateKey, held)
    if (!isCurrentRun(creationId, gateKey)) {
      // Cancelled (or restarted) before the sign-in existed.
      cancelAgentSignIn(gateKey)
    } else if (agentSignInGateEntry(gateKey)?.view.step === 'need') {
      // A pane may already be signing this agent in there; the sheet then only follows it.
      startAgentSignIn(gateKey)
    }
    const outcome = await held
    const signed = lastView as AgentSignInGateView | null
    const run = runs.get(creationId)
    if (outcome === 'proceed' && signed?.step === 'signed' && run?.gateKey === gateKey) {
      update(creationId, gateKey, {
        signedIn: [
          ...run.signedIn.filter((entry) => entry.agent !== agent),
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
  const previous = runs.get(creationId)
  if (previous?.running || agents.length === 0) {
    return
  }
  generation += 1
  const gateKey = `vm-build-sheet:${creationId}:${generation}`
  runs.set(creationId, {
    environmentId,
    gateKey,
    running: true,
    current: null,
    next: agents,
    // A retried create builds a new VM; what the old one signed in says nothing about it.
    signedIn: previous?.environmentId === environmentId ? previous.signedIn : []
  })
  notify()
  for (const [index, agent] of agents.entries()) {
    if (!isCurrentRun(creationId, gateKey)) {
      break
    }
    update(creationId, gateKey, { current: agent, next: agents.slice(index + 1) })
    if ((await signInOne(creationId, gateKey, hostLabel, agent)) === 'cancel') {
      break
    }
  }
  update(creationId, gateKey, { running: false, current: null, next: [] })
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    runs.delete(creationId)
    notify()
  }
}

/** Stops the run at once; a pane still waiting on the same sign-in keeps it. */
export function cancelVmBuildAgentSignIn(creationId: string): void {
  const run = runs.get(creationId)
  if (!run) {
    return
  }
  // A fresh key detaches the old loop, so Sign in works again right away.
  runs.set(creationId, {
    ...run,
    gateKey: `${run.gateKey}:cancelled`,
    running: false,
    current: null,
    next: []
  })
  notify()
  cancelAgentSignIn(run.gateKey)
}

/** Forgets an agent the sheet signed in, e.g. after switching its account on the host. */
export function forgetVmBuildSignedInAgent(creationId: string, agent: HostAgentSignInAgent): void {
  const run = runs.get(creationId)
  if (run) {
    update(creationId, run.gateKey, {
      signedIn: run.signedIn.filter((entry) => entry.agent !== agent)
    })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The sheet's run for this creation, only while it is about this VM. */
export function useVmBuildAgentSignIn(
  creationId: string,
  environmentId: string
): VmBuildAgentSignIn | null {
  const run = useSyncExternalStore(subscribe, () => runs.get(creationId) ?? null)
  return run?.environmentId === environmentId ? run : null
}

export function _resetVmBuildAgentSignInForTest(): void {
  runs.clear()
  listeners.clear()
}

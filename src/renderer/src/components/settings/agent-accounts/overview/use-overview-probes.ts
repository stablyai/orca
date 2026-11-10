// S3 probing (§7 "Scaling"): on open, awake and connected hosts only, at most four at once; each host
// answers from its own 60 s cache. No polling. Hosts that are stopped, suspended, disconnected or
// unreachable are never asked: their last cached verdict shows with its date.
import { useCallback, useEffect, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  readHostAgentSignInReport,
  refreshHostAgentSignInReport
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import type { HostAgentSignInReport } from '../../../../../../shared/host-agent-sign-in-status'
import type { OverviewAgent, OverviewHost, OverviewProbe } from './agent-accounts-overview-model'

const MAX_IN_FLIGHT = 4

type Answer = { report: HostAgentSignInReport | null; expired: OverviewAgent[] }

/** Which hosts the overview may ask now. */
export function overviewProbeTargets(hosts: readonly OverviewHost[]): OverviewHost[] {
  return hosts.filter(
    (host) =>
      host.availability === 'available' &&
      host.kind !== 'sshClassic' &&
      (host.kind === 'local' || host.environmentId !== null)
  )
}

/** Signed in at the last cached verdict, signed out in the new one. */
export function expiredAgents(
  before: HostAgentSignInReport | null,
  after: HostAgentSignInReport | null
): OverviewAgent[] {
  if (!before || !after) {
    return []
  }
  return after.agents
    .filter(
      (entry) =>
        entry.state === 'signedOut' &&
        before.agents.some(
          (previous) => previous.agent === entry.agent && previous.state === 'signedIn'
        )
    )
    .map((entry) => entry.agent)
}

async function ask(host: OverviewHost, force: boolean): Promise<Answer> {
  if (host.kind === 'local') {
    const report = await callRuntimeRpc<HostAgentSignInReport>(
      { kind: 'local' },
      'accounts.agentSignInStatus',
      force ? { force: true } : {}
    ).catch(() => null)
    return { report, expired: [] }
  }
  const environmentId = host.environmentId ?? ''
  const before = readHostAgentSignInReport(environmentId)
  const report = await refreshHostAgentSignInReport(environmentId, { force })
  return { report, expired: expiredAgents(before, report) }
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) {
        await work(item)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

export function useOverviewProbes(hosts: readonly OverviewHost[]): {
  probes: Record<string, OverviewProbe>
  checkAgain: (host: OverviewHost) => void
  /** Announced once after the first pass. */
  firstPassDone: boolean
} {
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [asking, setAsking] = useState<ReadonlySet<string>>(new Set())
  const [firstPassDone, setFirstPassDone] = useState(false)
  const targetKey = overviewProbeTargets(hosts)
    .map((host) => host.hostId)
    .join('\u0000')

  // Each host is asked once per open (never on a timer); a host that becomes askable later is
  // asked then.
  const asked = useRef(new Set<string>())
  useEffect(() => {
    const targets = overviewProbeTargets(hosts).filter((host) => !asked.current.has(host.hostId))
    for (const host of targets) {
      asked.current.add(host.hostId)
    }
    if (targets.length === 0) {
      return
    }
    // Answers land even after a re-render; asked hosts aren't asked again on this open.
    void runLimited(targets, MAX_IN_FLIGHT, async (host) => {
      const answer = await ask(host, false)
      setAnswers((current) => ({ ...current, [host.hostId]: answer }))
    }).then(() => setFirstPassDone(true))
  }, [hosts])

  const checkAgain = useCallback((host: OverviewHost) => {
    if (overviewProbeTargets([host]).length === 0) {
      return
    }
    setAsking((current) => new Set(current).add(host.hostId))
    void ask(host, true).then((answer) => {
      setAnswers((current) => ({ ...current, [host.hostId]: answer }))
      setAsking((current) => {
        const next = new Set(current)
        next.delete(host.hostId)
        return next
      })
    })
  }, [])

  const askable = new Set(targetKey ? targetKey.split('\u0000') : [])
  const probes: Record<string, OverviewProbe> = {}
  for (const host of hosts) {
    const answer = answers[host.hostId]
    const cached =
      host.environmentId !== null ? readHostAgentSignInReport(host.environmentId) : null
    probes[host.hostId] = {
      report: answer?.report ?? cached,
      checking: askable.has(host.hostId) && (answer === undefined || asking.has(host.hostId)),
      failed: answer !== undefined && answer.report === null,
      expired: answer?.expired ?? []
    }
  }
  return { probes, checkAgain, firstPassDone }
}

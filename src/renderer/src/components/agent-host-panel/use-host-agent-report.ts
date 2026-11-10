// The host's sign-in verdicts for the panel. The last cached report shows at once; the host is asked
// once per open, and only while it can answer. A stopped, suspended, disconnected or unreachable host
// is never connected, started, woken or resumed to check.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  readHostAgentSignInReport,
  refreshHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import type { HostAgentSignInReport } from '../../../../shared/host-agent-sign-in-status'
import type { AgentHostAvailability, AgentHostKind } from './agent-host-capabilities'

export type HostAgentReport = {
  report: HostAgentSignInReport | null
  /** A check is running for this open. */
  checking: boolean
  /** The host answered nothing (older Orca, or it went away). */
  failed: boolean
}

const NO_ENVIRONMENT = '\u0000'

export function useHostAgentReport(args: {
  kind: AgentHostKind
  availability: AgentHostAvailability
  environmentId: string | null
  /** Bumped by "Check again". */
  generation: number
}): HostAgentReport {
  const { kind, availability, environmentId, generation } = args
  const remoteId = kind === 'local' || kind === 'sshClassic' ? null : environmentId
  const cached = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    readHostAgentSignInReport(remoteId ?? NO_ENVIRONMENT)
  )
  const canAsk = availability === 'available' && (kind === 'local' || remoteId !== null)
  const askKey = canAsk ? `${kind}:${remoteId ?? ''}:${generation}` : null
  // Set only when an answer arrives (never synchronously in the effect), keyed by what was asked.
  const [answer, setAnswer] = useState<{
    key: string
    report: HostAgentSignInReport | null
  } | null>(null)

  useEffect(() => {
    if (!askKey) {
      return
    }
    let cancelled = false
    const ask: Promise<HostAgentSignInReport | null> =
      kind === 'local'
        ? callRuntimeRpc<HostAgentSignInReport>(
            { kind: 'local' },
            'accounts.agentSignInStatus',
            generation > 0 ? { force: true } : {}
          ).catch(() => null)
        : refreshHostAgentSignInReport(remoteId ?? '', { force: generation > 0 })
    void ask.then((report) => {
      if (!cancelled) {
        setAnswer({ key: askKey, report })
      }
    })
    return () => {
      cancelled = true
    }
  }, [askKey, kind, remoteId, generation])

  const answered = answer !== null && answer.key === askKey
  const checking = askKey !== null && !answered
  const failed = answered && answer.report === null
  const local = kind === 'local' && answer ? answer.report : null
  return { report: kind === 'local' ? local : cached, checking, failed }
}

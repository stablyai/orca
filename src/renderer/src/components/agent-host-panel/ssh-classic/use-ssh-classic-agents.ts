// Section 1 data for a classic SSH host: the last report (dated while disconnected), one ask per
// open while connected, and any code sign-in running there.
import { useEffect, useState } from 'react'
import {
  refreshSshAgentReport,
  useSshAgentState
} from '@/lib/ssh-agent-sign-in/ssh-agent-sign-in-store'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import type { ResolvedAgentHost } from '../use-agent-host'
import type { HostAgentReport } from '../use-host-agent-report'

export function sshTargetIdOf(hostId: string): string | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? parsed.targetId : null
}

export function useSshClassicAgents(
  host: ResolvedAgentHost,
  generation: number
): HostAgentReport & {
  targetId: string | null
  flows: ReturnType<typeof useSshAgentState>['flows']
} {
  const targetId = host.kind === 'sshClassic' ? sshTargetIdOf(host.hostId) : null
  const state = useSshAgentState(targetId)
  const askKey = targetId && host.availability === 'available' ? `${targetId}:${generation}` : null
  // Set only when an answer arrives, keyed by what was asked (never synchronously in the effect).
  const [answered, setAnswered] = useState<string | null>(null)
  useEffect(() => {
    if (!askKey || !targetId) {
      return
    }
    void refreshSshAgentReport(targetId, generation > 0).then(() => setAnswered(askKey))
  }, [askKey, targetId, generation])
  return {
    targetId,
    report: state.report,
    checking: askKey !== null && answered !== askKey,
    failed: askKey !== null && answered === askKey && state.failed,
    flows: state.flows
  }
}

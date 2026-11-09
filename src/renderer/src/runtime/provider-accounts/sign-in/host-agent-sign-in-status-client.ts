import type {
  HostAgentSignInAgent,
  HostAgentSignInEntry,
  HostAgentSignInReport
} from '../../../../../shared/host-agent-sign-in-status'
import { HOST_AGENT_SIGN_IN_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/account-runtime-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

const CALL_TIMEOUT_MS = 30_000

type Entry = {
  report: HostAgentSignInReport | null
  pending: Promise<HostAgentSignInReport | null> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

async function fetchReport(
  environmentId: string,
  force: boolean
): Promise<HostAgentSignInReport | null> {
  try {
    if (
      !(await runtimeEnvironmentSupportsCapability(
        environmentId,
        HOST_AGENT_SIGN_IN_STATUS_RUNTIME_CAPABILITY
      ))
    ) {
      return null
    }
    return await callRuntimeRpc<HostAgentSignInReport>(
      { kind: 'environment', environmentId },
      'accounts.agentSignInStatus',
      force ? { force: true } : {},
      { timeoutMs: CALL_TIMEOUT_MS }
    )
  } catch {
    // An older, asleep or unreachable host answers nothing; launches there proceed as before.
    return null
  }
}

/** The host's last verdicts, without asking. */
export function readHostAgentSignInReport(environmentId: string): HostAgentSignInReport | null {
  return entries.get(environmentId)?.report ?? null
}

export function hostAgentSignInEntry(
  report: HostAgentSignInReport | null,
  agent: HostAgentSignInAgent
): HostAgentSignInEntry | null {
  return report?.agents.find((entry) => entry.agent === agent) ?? null
}

export function subscribeHostAgentSignInReports(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Asks the host; concurrent callers share one request. `force` skips the host's own cache. */
export function refreshHostAgentSignInReport(
  environmentId: string,
  options: { force?: boolean } = {}
): Promise<HostAgentSignInReport | null> {
  const entry = entries.get(environmentId) ?? { report: null, pending: null }
  if (entry.pending && !options.force) {
    return entry.pending
  }
  const pending = fetchReport(environmentId, options.force === true).then((report) => {
    const current = entries.get(environmentId)
    if (current?.pending === pending) {
      entries.set(environmentId, { report: report ?? current.report, pending: null })
      notify()
    }
    return report
  })
  entries.set(environmentId, { report: entry.report, pending })
  return pending
}

/** Records a verdict the host returned from another call (sign-out answers with a fresh report). */
export function rememberHostAgentSignInReport(
  environmentId: string,
  report: HostAgentSignInReport
): void {
  entries.set(environmentId, { report, pending: null })
  notify()
}

export function _resetHostAgentSignInReportsForTest(): void {
  entries.clear()
  listeners.clear()
}

import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/**
 * Asks the host whether ANY terminal is live in an environment, for the one
 * question the session-tab mirror cannot answer: a live host that has not
 * published yet returns the same empty inventory as a host with no terminals
 * at all. `terminal.list` reads the PTY controller — `ptysById` plus the
 * cross-generation daemon inventory — not the mirror, so it sees exactly that
 * gap.
 *
 * `unverifiable` is a verdict, never a synonym for `none`: loss of contact
 * with the execution host is no evidence a host-owned PTY exited.
 */
export type HostLiveTerminalProbeVerdict = 'live' | 'none' | 'unverifiable'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

type ValidTerminalListResult = RuntimeTerminalListResult & {
  totalCount: number
}

const inFlightProbeByEnvironment = new Map<string, Promise<HostLiveTerminalProbeVerdict>>()

function isTerminalListResult(value: unknown): value is ValidTerminalListResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { terminals?: unknown }).terminals) ||
    !Number.isInteger((value as { totalCount?: unknown }).totalCount) ||
    (value as { totalCount: number }).totalCount < 0
  ) {
    return false
  }
  const hostScope = (value as { hostScope?: unknown }).hostScope
  if (hostScope === undefined) {
    // Older hosts do not publish scope; preserve their best-effort list result.
    return true
  }
  return (
    Boolean(hostScope) &&
    typeof hostScope === 'object' &&
    Array.isArray((hostScope as { hostIds?: unknown }).hostIds) &&
    Array.isArray((hostScope as { omittedHostIds?: unknown }).omittedHostIds)
  )
}

async function probeHost(
  environmentId: string,
  call: RuntimeCall,
  expectedEnvironmentPairingRevision?: number
): Promise<HostLiveTerminalProbeVerdict> {
  const response = await call({
    selector: environmentId,
    method: 'terminal.list',
    params: {
      // Why: one row settles "any", and `totalCount` is the pre-limit census.
      limit: 1,
      // Why: without it an unavailable daemon inventory answers from stale PTY
      // records — a false empty. It raises `terminal_liveness_unavailable`
      // instead, which lands here as `unverifiable`.
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    },
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision
  })
  if (response.ok === false || !isTerminalListResult(response.result)) {
    return 'unverifiable'
  }
  // An omitted execution host is an incomplete census. In particular, a relay
  // can list its local PTYs while an SSH child host is still starting up.
  const hostScope = response.result.hostScope
  if (hostScope && hostScope.omittedHostIds.length > 0) {
    return 'unverifiable'
  }
  const { terminals, totalCount } = response.result
  return terminals.length > 0 || (typeof totalCount === 'number' && totalCount > 0)
    ? 'live'
    : 'none'
}

export function probeHostLiveTerminals(
  environmentId: string,
  call: RuntimeCall = (args) => window.api.runtimeEnvironments.call(args),
  connectionGeneration = 0,
  expectedEnvironmentPairingRevision?: number
): Promise<HostLiveTerminalProbeVerdict> {
  const key = `${environmentId}\0${connectionGeneration}\0${expectedEnvironmentPairingRevision ?? 'unknown'}`
  const existing = inFlightProbeByEnvironment.get(key)
  if (existing) {
    return existing
  }
  const probe = probeHost(environmentId, call, expectedEnvironmentPairingRevision)
    .catch((): HostLiveTerminalProbeVerdict => 'unverifiable')
    .finally(() => {
      if (inFlightProbeByEnvironment.get(key) === probe) {
        inFlightProbeByEnvironment.delete(key)
      }
    })
  inFlightProbeByEnvironment.set(key, probe)
  return probe
}

export function clearHostLiveTerminalProbesForTests(): void {
  inFlightProbeByEnvironment.clear()
}

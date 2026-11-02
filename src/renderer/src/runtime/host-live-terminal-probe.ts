import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { hostScopeCensusIsComplete } from '../../../shared/runtime-listing-host-scope'

/** Probe PTY controller plus daemon inventory, not the session mirror: unpublished live terminals and empty hosts look identical there. unverifiable never means none; lost contact proves no exit. */
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
      // Require daemon liveness: stale PTY records can falsely look empty. terminal_liveness_unavailable becomes unverifiable.
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    },
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision
  })
  if (response.ok === false || !isTerminalListResult(response.result)) {
    return 'unverifiable'
  }
  // Missing owed host coverage means incomplete census, including starting SSH children. Peer runtimes answer environment for themselves; treating disclosure as a gap latched probes forever (#18595).
  const hostScope = response.result.hostScope
  if (hostScope && !hostScopeCensusIsComplete(hostScope)) {
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

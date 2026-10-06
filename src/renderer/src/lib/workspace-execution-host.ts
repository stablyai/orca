import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardCardHostKind
} from '../../../shared/dashboard-snapshot'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'

/**
 * The two host kinds a workspace can be named by before any pty is consulted.
 * `wsl` is deliberately absent: it is a refinement the dashboard reads off the
 * live pty's platform, not something the workspace catalogs know.
 */
export type RemoteExecutionHostKind = Extract<DashboardCardHostKind, 'ssh' | 'remote'>

/** Null means the workspace runs on the client — see docs/reference/ssh-execution-boundary.md. */
export function resolveRemoteExecutionHostKind(
  connectionId: string | null | undefined,
  executionHostId: string | null | undefined
): RemoteExecutionHostKind | null {
  if (connectionId || executionHostId?.startsWith('ssh:')) {
    return 'ssh'
  }
  return executionHostId && executionHostId !== 'local' ? 'remote' : null
}

export type ExecutionHostLabelSources = {
  sshTargetLabels?: ReadonlyMap<string, string> | null
  runtimeEnvironments?: readonly { id: string; name: string }[] | null
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides'] | null
}

function buildHostLabelLookup(
  sources: ExecutionHostLabelSources
): ReadonlyMap<ExecutionHostId, string> {
  const labels = new Map<ExecutionHostId, string>()
  for (const [targetId, label] of sources.sshTargetLabels ?? []) {
    labels.set(toSshExecutionHostId(targetId), label)
  }
  for (const environment of sources.runtimeEnvironments ?? []) {
    labels.set(toRuntimeExecutionHostId(environment.id), environment.name)
  }
  // The user's own rename wins over whatever the target or environment calls itself.
  for (const [hostId, label] of getHostDisplayLabelOverrides({
    hostSettingOverrides: sources.hostSettingOverrides ?? undefined
  })) {
    labels.set(hostId, label)
  }
  return labels
}

/**
 * `hostId -> display label` for remote hosts only; local hosts have no badge to label.
 * The lookup is built on first use so a listing with no remote workspace pays nothing.
 */
export function createExecutionHostLabelResolver(
  sources: ExecutionHostLabelSources
): (executionHostId: ExecutionHostId) => string | undefined {
  let labels: ReadonlyMap<ExecutionHostId, string> | null = null
  return (executionHostId) => {
    const parsed = parseExecutionHostId(executionHostId)
    if (parsed?.kind !== 'ssh' && parsed?.kind !== 'runtime') {
      return undefined
    }
    labels ??= buildHostLabelLookup(sources)
    const label =
      labels.get(executionHostId) ??
      (parsed.kind === 'ssh' ? parsed.targetId : parsed.environmentId)
    return label.length > DASHBOARD_MAX_LABEL_LENGTH
      ? label.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
      : label
  }
}

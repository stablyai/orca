// Why (#8711): managed hook state is per-host, but `orca agent hooks status`
// only ever read the machine running Orca. For an SSH worktree the agent runs
// somewhere else entirely, so a green local report validated a file the agent
// could never read. Every status surface now names the host it checked, and a
// host Orca could not check reports `unknown` rather than borrowing the local
// answer.

import type { AgentHookInstallStatus } from './agent-hook-types'

/** The host that actually executes the agent whose hooks are being reported. */
export type AgentHookHost =
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string; label: string }
  | { kind: 'wsl'; distro: string }

export type AgentHookHostState =
  | 'installed'
  | 'partial'
  | 'error'
  /** Orca deliberately did not install here (hooks off, Windows remote, no agent CLI). */
  | 'skipped'
  /** Orca could not determine this host's state — never treat as installed. */
  | 'unknown'

/** A host's managed-hook state before it is attached to a named host. */
export type AgentHookHostOutcome = {
  state: AgentHookHostState
  detail: string | null
  /** Per-agent detail, when the host could report it. Empty for `unknown`, and
   *  for hosts whose relay predates the per-agent field on the install RPC. */
  statuses: readonly AgentHookInstallStatus[]
}

export type AgentHookHostReport = AgentHookHostOutcome & {
  host: AgentHookHost
}

export function describeAgentHookHost(host: AgentHookHost): string {
  switch (host.kind) {
    case 'local':
      return 'local'
    case 'ssh':
      return `ssh:${host.label}`
    case 'wsl':
      return `wsl:${host.distro}`
  }
}

/** Rolls per-agent results into one host verdict. An empty list is `unknown`:
 *  "nothing to report" and "nothing was checked" must not both read as green. */
export function summarizeAgentHookHostState(
  statuses: readonly AgentHookInstallStatus[]
): AgentHookHostState {
  if (statuses.length === 0) {
    return 'unknown'
  }
  if (statuses.some((status) => status.state === 'error')) {
    return statuses.every((status) => status.state === 'error') ? 'error' : 'partial'
  }
  if (statuses.every((status) => status.state === 'skipped')) {
    return 'skipped'
  }
  if (statuses.some((status) => status.state === 'not_installed' || status.state === 'partial')) {
    return 'partial'
  }
  return 'installed'
}

function formatAgentLine(status: AgentHookInstallStatus): string {
  const detail = status.detail ? ` — ${status.detail}` : ''
  return `  ${status.agent}: ${status.state}${detail}`
}

export function formatAgentHookHostReport(report: AgentHookHostReport): string {
  const detail = report.detail ? ` — ${report.detail}` : ''
  return [
    `${describeAgentHookHost(report.host)}: ${report.state}${detail}`,
    ...report.statuses.map(formatAgentLine)
  ].join('\n')
}

export function formatAgentHookHostReports(reports: readonly AgentHookHostReport[]): string {
  return reports.map(formatAgentHookHostReport).join('\n')
}

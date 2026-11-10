// Resolves the panel's host from what the renderer already holds (sidebar host options, saved
// environments, the Cloud workspace snapshot). Reads only: no connect, wake, start or resume.
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { useNow } from '@/hooks/use-now'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  deriveCloudDotState,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { cloudSecretRepoKey } from '../settings/cloud-secrets/cloud-secret-repos'
import { runtimeEnvironmentDisplayName } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { selectStartableStoppedWslDistro } from '../wsl-host-stopped/use-stopped-wsl-host'
import type { AgentHostAvailability, AgentHostKind } from './agent-host-capabilities'
import { agentHostAvailability, agentHostKind } from './agent-host-kind'
import type { AgentHostPanelRequest } from './agent-host-panel-store'

export type ResolvedAgentHost = {
  hostId: ExecutionHostId
  label: string
  kind: AgentHostKind
  availability: AgentHostAvailability
  /** The runtime environment behind the host; null for this computer and plain SSH. */
  environmentId: string | null
  cloud: {
    workspaceId: string | null
    /** "repo · workspace", for the subline. */
    workspaceLabel: string | null
    repoKey: string | null
    dot: CloudDotState
  } | null
}

function useCloudWorkspaceOnHost(
  request: AgentHostPanelRequest | null
): { id: string; label: string; repoKey: string | null } | null {
  return useAppStore(
    useShallow((s) => {
      if (!request) {
        return null
      }
      for (const repo of s.repos) {
        for (const worktree of selectWorktreesByRepo(s)[repo.id] ?? []) {
          const matches = request.workspaceId
            ? worktree.id === request.workspaceId
            : getWorktreeExecutionHostId(worktree, repo) === request.hostId
          if (matches) {
            return {
              id: worktree.id,
              label: `${repo.displayName} · ${worktree.displayName}`,
              repoKey: cloudSecretRepoKey(repo)
            }
          }
        }
      }
      return null
    })
  )
}

export function useResolvedAgentHost(
  request: AgentHostPanelRequest | null
): ResolvedAgentHost | null {
  const parsed = request ? parseExecutionHostId(request.hostId) : null
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
  const environment = useAppStore((s) =>
    environmentId
      ? (s.runtimeEnvironments.find((entry) => entry.id === environmentId) ?? null)
      : null
  )
  const wslStopped = useAppStore((s) => selectStartableStoppedWslDistro(s, environmentId) !== null)
  const workspace = useCloudWorkspaceOnHost(request)
  const cloudStatus = useCloudWorkspace((s) => (workspace ? s.status[workspace.id] : undefined))
  const wake = useCloudWorkspace((s) => (workspace ? s.wake[workspace.id] : undefined))
  // Only a wake's staleness reads the clock; a slow tick is plenty.
  const now = useNow(30_000, wake !== undefined)
  if (!request || !parsed) {
    return null
  }
  const option = request.host
  const kind = agentHostKind(parsed.kind, environment)
  const dot =
    kind === 'cloud'
      ? deriveCloudDotState({
          status: cloudStatus?.status ?? null,
          wake,
          sleeping: false,
          now
        })
      : null
  return {
    hostId: request.hostId,
    label:
      option?.label ?? (environment ? runtimeEnvironmentDisplayName(environment) : request.hostId),
    kind,
    availability: agentHostAvailability(kind, {
      health: option?.health ?? (parsed.kind === 'local' ? 'local' : 'disconnected'),
      wslStopped,
      cloud: dot ? { asleep: dot === 'sleeping', archived: dot === 'archived' } : null
    }),
    environmentId,
    cloud:
      kind === 'cloud' && dot
        ? {
            workspaceId: workspace?.id ?? null,
            workspaceLabel: workspace?.label ?? null,
            repoKey: workspace?.repoKey ?? null,
            dot
          }
        : null
  }
}

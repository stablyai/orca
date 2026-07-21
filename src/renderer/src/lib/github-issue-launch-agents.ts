import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { Repo, TuiAgent } from '../../../shared/types'

type GitHubIssueLaunchAgentStore = {
  settings?: { disabledTuiAgents?: Iterable<unknown> | null } | null
  ensureDetectedAgents: () => Promise<TuiAgent[]>
  ensureRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
}

export async function loadGitHubIssueLaunchAgents(
  repo: Repo | null,
  store: GitHubIssueLaunchAgentStore = useAppStore.getState()
): Promise<AgentCatalogEntry[]> {
  if (!repo) {
    return []
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const detectedAgents =
    host?.kind === 'ssh'
      ? await store.ensureRemoteDetectedAgents(host.targetId)
      : host?.kind === 'runtime'
        ? await store.ensureRuntimeDetectedAgents(host.environmentId)
        : await store.ensureDetectedAgents()
  const enabledAgents = new Set(
    filterEnabledTuiAgents(detectedAgents, store.settings?.disabledTuiAgents)
  )
  return getAgentCatalog().filter((agent) => enabledAgents.has(agent.id))
}

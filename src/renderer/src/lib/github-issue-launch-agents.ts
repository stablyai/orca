import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { Repo, TuiAgent } from '../../../shared/types'

type GitHubIssueLaunchAgentStore = {
  settings?: { disabledTuiAgents?: Iterable<unknown> | null } | null
  ensureDetectedAgents: (target?: { repoId: string }) => Promise<TuiAgent[]>
  ensureRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
}

type GitHubIssueLaunchAgentStoreSource =
  | GitHubIssueLaunchAgentStore
  | (() => GitHubIssueLaunchAgentStore)

function readStore(source: GitHubIssueLaunchAgentStoreSource): GitHubIssueLaunchAgentStore {
  return typeof source === 'function' ? source() : source
}

export async function loadGitHubIssueLaunchAgents(
  repo: Repo | null,
  storeSource: GitHubIssueLaunchAgentStoreSource = () => useAppStore.getState()
): Promise<AgentCatalogEntry[]> {
  if (!repo) {
    return []
  }
  const store = readStore(storeSource)
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const detectedAgents =
    host?.kind === 'ssh'
      ? await store.ensureRemoteDetectedAgents(host.targetId)
      : host?.kind === 'runtime'
        ? await store.ensureRuntimeDetectedAgents(host.environmentId)
        : await store.ensureDetectedAgents({ repoId: repo.id })
  const currentStore = readStore(storeSource)
  const enabledAgents = new Set(
    filterEnabledTuiAgents(detectedAgents, currentStore.settings?.disabledTuiAgents)
  )
  return getAgentCatalog().filter((agent) => enabledAgents.has(agent.id))
}

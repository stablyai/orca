import { useMemo } from 'react'
import { useSidebarHostScopeOptions } from '../../sidebar/worktree-list/controls/use-sidebar-host-scope-options'
import { AgentApiKeysPane } from './AgentApiKeysPane'
import type { AgentApiKeyHostChoice } from './AgentApiKeyEditor'
import { useAgentApiKeys } from './use-agent-api-keys'

/** Desktop-owned: the same keys apply whichever host Settings is showing. */
export function AgentApiKeysSection(): React.JSX.Element {
  const model = useAgentApiKeys(window.api.agentApiKeys)
  const { hostOptions } = useSidebarHostScopeOptions()
  const hosts = useMemo<AgentApiKeyHostChoice[]>(
    () =>
      hostOptions
        .filter((host) => !host.mergedIntoHostId)
        .map((host) => ({
          id: host.id,
          label: host.label,
          ...(host.aliasHostIds ? { aliasHostIds: host.aliasHostIds } : {})
        })),
    [hostOptions]
  )
  return <AgentApiKeysPane model={model} hosts={hosts} />
}

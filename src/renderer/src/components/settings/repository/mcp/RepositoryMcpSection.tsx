// Repository settings' MCP block: the host's MCP servers for this repo where the repo's host serves
// them (`mcp-servers.v1`), else the read-only MCP configs it shows today.
import React from 'react'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId
} from '../../../../../../shared/execution-host/execution-host'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../../shared/mcp-servers/mcp-servers'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { McpConfigSection } from './McpConfigSection'
import { McpRepoServersSection } from './McpRepoServersSection'

export function RepositoryMcpSection({ repo }: { repo: Repo }): React.JSX.Element | null {
  // A direct SSH repo has no Orca runtime to keep a server list.
  const target = getRepoSshConnectionId(repo)
    ? null
    : ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    MCP_SERVERS_RUNTIME_CAPABILITY
  )
  if (target && support === 'unknown') {
    // Neither section until the host answers: the old one would show, then swap for the new one.
    return null
  }
  return target && support === 'supported' ? (
    <McpRepoServersSection repo={repo} target={target} />
  ) : (
    <McpConfigSection repo={repo} />
  )
}

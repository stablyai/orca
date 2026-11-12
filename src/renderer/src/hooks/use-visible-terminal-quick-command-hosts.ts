import { useMemo } from 'react'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal/quick-commands/terminal-quick-command-project-scope'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../shared/terminal/quick-commands/terminal-quick-commands'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  TerminalQuickCommandHost,
  TerminalQuickCommandMenuHost
} from './use-terminal-quick-command-hosts'

export function useVisibleTerminalQuickCommandHosts(
  hosts: TerminalQuickCommandHost[],
  executionHostId: ExecutionHostId,
  repoId: string | null
): TerminalQuickCommandMenuHost[] {
  const projection = useProjectHostSetupProjection()
  return useMemo(
    () =>
      hosts.map((host) => {
        const commands = host.commands.filter(isTerminalQuickCommandComplete)
        return {
          hostId: host.hostId,
          label: host.label,
          globalCommands: commands.filter(
            (command) => getTerminalQuickCommandScope(command).type === 'global'
          ),
          repoCommands: commands.filter(
            (command) =>
              getTerminalQuickCommandScope(command).type === 'repo' &&
              terminalQuickCommandMatchesWorkspaceProject(command, {
                commandHostId: host.hostId,
                projectHostSetups: projection.setups,
                targetHostId: executionHostId,
                targetRepoId: repoId
              })
          )
        }
      }),
    [hosts, executionHostId, repoId, projection.setups]
  )
}

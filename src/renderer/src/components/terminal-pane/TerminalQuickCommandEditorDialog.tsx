import { useAppStore } from '../../store'
import { getTerminalQuickCommandHostPromptMaxLength } from '@/lib/terminal-quick-command-host-prompt-limit'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { TerminalQuickCommandDialog } from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'

export function TerminalQuickCommandEditorDialog({
  command,
  hostId,
  onOpenChange,
  onSave
}: {
  command: TerminalQuickCommand
  hostId: ExecutionHostId
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => Promise<boolean>
}): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const agentPromptMaxLength = useAppStore((store) =>
    getTerminalQuickCommandHostPromptMaxLength(store, hostId)
  )
  const hostRepos = hostId.startsWith('runtime:')
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    : repos

  return (
    <TerminalQuickCommandDialog
      open
      mode="add"
      command={command}
      repos={hostRepos}
      agentPromptMaxLength={agentPromptMaxLength}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

import { useAppStore } from '../../store'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
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
  onSave: (command: TerminalQuickCommand) => void
}): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const hostRepos = hostId.startsWith('runtime:')
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    : repos

  return (
    <TerminalQuickCommandDialog
      open
      mode="add"
      command={command}
      repos={hostRepos}
      showBackgroundPreference={hostId === LOCAL_EXECUTION_HOST_ID}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

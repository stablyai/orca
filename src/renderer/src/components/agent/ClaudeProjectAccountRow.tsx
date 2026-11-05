import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const FOLLOW_SELECTION = '__selection__'

/** The Claude account a local project's terminals launch under, saved on the project. */
export function ClaudeProjectAccountRow({
  entry,
  disabled
}: {
  entry: AgentPickerEntry
  disabled?: boolean
}): React.JSX.Element | null {
  const repoId = entry.draftTarget?.repoId
  const repo = useAppStore((s) =>
    repoId ? s.repos.find((candidate) => candidate.id === repoId) : undefined
  )
  const settings = useAppStore((s) => s.settings)
  const updateRepo = useAppStore((s) => s.updateRepo)
  if (entry.agent !== 'claude' || !repo || getRepoExecutionHostId(repo) !== 'local') {
    return null
  }
  // WSL accounts live in a guest the host terminal cannot reach.
  const accounts = (settings?.claudeManagedAccounts ?? []).filter(
    (account) => account.managedAuthRuntime !== 'wsl'
  )
  if (accounts.length === 0) {
    return null
  }
  const selectedId =
    settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
    settings?.activeClaudeManagedAccountId ??
    null
  const selectedEmail = accounts.find((account) => account.id === selectedId)?.email
  const followLabel = selectedEmail
    ? translate('agentPicker.claudeAccountFollow', 'Active account ({{email}})', {
        email: selectedEmail
      })
    : translate('agentPicker.claudeAccountFollowDefault', 'Active account')
  const pinned = accounts.find((account) => account.id === repo.claudeAccountId)
  return (
    <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">
        {translate('agentPicker.claudeAccount', 'Account')}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={translate(
              'agentPicker.claudeAccountLabel',
              'Claude account for this project'
            )}
            className="min-w-0 max-w-full"
          >
            <span className="truncate text-xs">{pinned?.email ?? followLabel}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} className="w-72">
          <DropdownMenuRadioGroup
            value={pinned?.id ?? FOLLOW_SELECTION}
            onValueChange={(value) => {
              void updateRepo(
                repo.id,
                { claudeAccountId: value === FOLLOW_SELECTION ? null : value },
                { hostId: getRepoExecutionHostId(repo) }
              )
            }}
          >
            <DropdownMenuRadioItem value={FOLLOW_SELECTION}>{followLabel}</DropdownMenuRadioItem>
            {accounts.map((account) => (
              <DropdownMenuRadioItem key={account.id} value={account.id}>
                <span className="truncate">{account.email}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            {translate(
              'agentPicker.claudeAccountHint',
              'Saved for this project. New terminal sessions here use it; chats use the active account.'
            )}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

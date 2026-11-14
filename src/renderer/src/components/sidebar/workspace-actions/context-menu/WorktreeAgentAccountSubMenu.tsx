import { UserRound } from 'lucide-react'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { PinnableAgent } from '../../../../../../shared/worktree-account-pin-settings'

const FOLLOW_SELECTION = ''

const PIN_KEY = {
  claude: 'claudeAccountPinsByWorktree',
  codex: 'codexAccountPinsByWorktree'
} as const

/** Pins cover host launches only, so WSL accounts are not offered. */
function hostAccounts(settings: GlobalSettings, agent: PinnableAgent) {
  return agent === 'claude'
    ? settings.claudeManagedAccounts.filter((account) => account.managedAuthRuntime !== 'wsl')
    : settings.codexManagedAccounts.filter((account) => account.managedHomeRuntime !== 'wsl')
}

/** Worker accounts (#9496): the agent launched in this worktree runs on its own account, not the selection. */
export function WorktreeAgentAccountSubMenu({
  agent,
  worktreeId,
  disabled
}: {
  agent: PinnableAgent
  worktreeId: string
  disabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const accounts = settings ? hostAccounts(settings, agent) : []
  if (!settings || accounts.length === 0) {
    return null
  }
  const pins = settings[PIN_KEY[agent]] ?? {}
  const choose = (accountId: string): void => {
    const { [worktreeId]: _previous, ...others } = pins
    void updateSettings({
      [PIN_KEY[agent]]: accountId ? { ...others, [worktreeId]: accountId } : others
    })
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <UserRound className="size-3.5" />
        {agent === 'claude'
          ? t('accounts.worktreeAccount.claudeSubmenu', 'Claude Account')
          : t('accounts.worktreeAccount.codexSubmenu', 'Codex Account')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={pins[worktreeId] ?? FOLLOW_SELECTION} onValueChange={choose}>
          <DropdownMenuRadioItem value={FOLLOW_SELECTION} disabled={disabled}>
            {t('accounts.worktreeAccount.followSelection', 'Follow selected account')}
          </DropdownMenuRadioItem>
          {accounts.map((account) => (
            <DropdownMenuRadioItem
              key={account.id}
              value={account.id}
              textValue={account.email}
              disabled={disabled}
            >
              <span className="max-w-48 truncate">{account.email}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

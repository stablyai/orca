import React, { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  pinnableHostAccounts,
  type PinnableAgent,
  type WorktreeAccountPins
} from '../../../../../shared/worktree-account-pin-settings'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

// Radix Select refuses '' as an item value.
const FOLLOW_SELECTION = 'follow-selection'

function isPinnableAgent(agent: TuiAgent | null): agent is PinnableAgent {
  return agent === 'claude' || agent === 'codex'
}

/**
 * The create dialog's account choice: kept per agent, offered and sent only for an agent that
 * launches on this machine, so the host can pin the worktree before the agent starts.
 */
export function useNewWorkspaceAgentAccount(
  agent: TuiAgent | null,
  localLaunch: boolean,
  disabled: boolean
): { field: React.ReactNode; accountPins: WorktreeAccountPins | undefined } {
  const [chosen, setChosen] = useState<WorktreeAccountPins>({})
  const pinnable = isPinnableAgent(agent) && localLaunch ? agent : null
  const accountId = pinnable ? chosen[pinnable] : undefined
  return {
    field: pinnable ? (
      <NewWorkspaceAgentAccountField
        agent={pinnable}
        accountId={accountId}
        onAccountChange={(next) => setChosen((current) => ({ ...current, [pinnable]: next }))}
        disabled={disabled}
      />
    ) : undefined,
    accountPins: pinnable && accountId ? { [pinnable]: accountId } : undefined
  }
}

/**
 * Worker accounts (#9496): the account the new worktree's agent runs on, chosen before it starts.
 * Shown for Claude and Codex on this machine when there are saved accounts to pick from.
 */
function NewWorkspaceAgentAccountField({
  agent,
  accountId,
  onAccountChange,
  disabled
}: {
  agent: PinnableAgent
  accountId: string | undefined
  onAccountChange: (accountId: string | undefined) => void
  disabled: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const accounts = settings ? pinnableHostAccounts(settings, agent) : []
  if (accounts.length === 0) {
    return null
  }
  const known = accountId && accounts.some((account) => account.id === accountId)
  return (
    <div className="min-w-0 space-y-1">
      <label
        className="text-xs font-medium text-muted-foreground"
        htmlFor="new-workspace-agent-account"
      >
        {agent === 'claude'
          ? t('accounts.worktreeAccount.claudeSubmenu', 'Claude Account')
          : t('accounts.worktreeAccount.codexSubmenu', 'Codex Account')}
      </label>
      <Select
        value={known ? accountId : FOLLOW_SELECTION}
        onValueChange={(value) => onAccountChange(value === FOLLOW_SELECTION ? undefined : value)}
        disabled={disabled}
      >
        <SelectTrigger id="new-workspace-agent-account" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_SELECTION}>
            {t('accounts.worktreeAccount.followSelection', 'Follow selected account')}
          </SelectItem>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              <span className="max-w-64 truncate">{account.email}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// The Claude accounts a bot's own account can name on its host, labelled as the status-bar switcher labels them.
import { buildClaudeStatusSwitchGroups } from '@/components/status-bar/accounts/status-bar-claude-accounts'
import {
  LAUNCH_ACCOUNT_SYSTEM,
  resolveClaudeAccountRef
} from '../../../../../shared/agent-accounts/launch-account-ref'
import { getManagedAccountInlineLabel } from '../../../../../shared/agent-accounts/managed-account-display-names'
import type { ClaudeRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'

// Select items need a non-empty value; this one clears the bot's account.
export const FOLLOW_HOST_ACCOUNT = 'follow-host'
export const UNKNOWN_BOT_ACCOUNT = 'unknown-account'

export type BotClaudeAccountChoice = {
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

export type BotClaudeAccountChoices = {
  choices: BotClaudeAccountChoice[]
  selected: string
  /** The saved account names no account the host lists; launches then follow the host's selection. */
  unknown: string | null
}

/** Matches `saved` the way a launch does (id, then email, then name), so an email or name a CLI saved still shows. */
export function botClaudeAccountChoices(
  state: ClaudeRateLimitAccountsState,
  saved: string | undefined
): BotClaudeAccountChoices {
  const ref = saved?.trim() ?? ''
  const names = {
    claude: Object.fromEntries(
      state.accounts.flatMap((account) =>
        account.displayName ? [[account.id, account.displayName]] : []
      )
    )
  }
  const resolved = ref ? resolveClaudeAccountRef(ref, state.accounts, names) : null
  const pinned = resolved?.kind === 'managed' ? resolved.accountId : null
  // Selecting the saved account makes the switcher's de-duplication keep its record, not a duplicate login's.
  const [host] = buildClaudeStatusSwitchGroups(
    { ...state, activeAccountId: pinned, activeAccountIdsByRuntime: { host: pinned, wsl: {} } },
    { runtime: 'host', wslDistro: null }
  )
  const choices: BotClaudeAccountChoice[] = host.targets.map((target) => ({
    value: target.id ?? LAUNCH_ACCOUNT_SYSTEM,
    label: target.label,
    ...(target.detail ? { detail: target.detail } : {}),
    ...(target.disabled && target.id !== pinned ? { disabled: true } : {})
  }))
  if (!ref) {
    return { choices, selected: FOLLOW_HOST_ACCOUNT, unknown: null }
  }
  if (resolved?.kind === 'system') {
    return { choices, selected: LAUNCH_ACCOUNT_SYSTEM, unknown: null }
  }
  if (pinned && !choices.some((choice) => choice.value === pinned)) {
    // A saved account outside the host group, such as a WSL one, is still the one launches name.
    const account = state.accounts.find((candidate) => candidate.id === pinned)
    if (account) {
      choices.push({ value: pinned, label: getManagedAccountInlineLabel(account) })
    }
  }
  return pinned
    ? { choices, selected: pinned, unknown: null }
    : { choices, selected: UNKNOWN_BOT_ACCOUNT, unknown: ref }
}

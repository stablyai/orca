import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getProviderAccountActiveIdForView } from '@/components/provider-accounts/provider-account-visibility'

const READ_BUDGET_MS = 1_500

/** The email of the account a launch would use: the selected one, else System default's. */
export function selectedAccountEmail(
  agent: HostAgentSignInAgent,
  state: ClaudeRateLimitAccountsState | CodexRateLimitAccountsState | null | undefined
): string | null {
  if (!state) {
    return null
  }
  const selectedId = getProviderAccountActiveIdForView(state, { runtime: 'host' })
  if (selectedId) {
    return state.accounts.find((account) => account.id === selectedId)?.email ?? null
  }
  return agent === 'claude'
    ? ((state as ClaudeRateLimitAccountsState).systemDefaultEmail ?? null)
    : ((state as CodexRateLimitAccountsState).systemDefault?.email ?? null)
}

/** The account this computer uses for `agent`; null in the web client, whose accounts live on its host. */
export async function readDesktopAgentEmail(agent: HostAgentSignInAgent): Promise<string | null> {
  if (isWebClientLocation()) {
    return null
  }
  const accounts = agent === 'claude' ? window.api.claudeAccounts : window.api.codexAccounts
  // Only a hint for the signed-in card; never let a slow read hold the launch.
  const state = await Promise.race([
    accounts?.list().catch(() => null) ?? null,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_BUDGET_MS))
  ])
  return selectedAccountEmail(agent, state)
}

/** The account this computer uses when the host signed in as a different one; null otherwise. */
export function differentAccountEmail(
  hostEmail: string | null,
  desktopEmail: string | null
): string | null {
  if (!hostEmail || !desktopEmail) {
    return null
  }
  return hostEmail.trim().toLowerCase() === desktopEmail.trim().toLowerCase() ? null : desktopEmail
}

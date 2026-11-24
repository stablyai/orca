import * as z from 'zod'
import type { ClaudeManagedAccount } from './managed-account-types'
import {
  getManagedAccountDisplayName,
  type ManagedAccountDisplayNames
} from './managed-account-display-names'

/** Names the host's System default account instead of a saved one. */
export const LAUNCH_ACCOUNT_SYSTEM = 'system'

/**
 * How a bot, an automation or a plugin names the account a launch should run under: a saved
 * account's id, its sign-in email, its display name (label), or `system` for the System default.
 * Free text on purpose: it is matched at launch, so a stale value falls back to the host's
 * selection instead of voiding the record that holds it.
 */
export const AgentAccountRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value), 'Account names cannot contain control characters')

export type AgentAccountRef = z.infer<typeof AgentAccountRefSchema>

export type ResolvedLaunchAccount =
  /** A saved account. */
  { kind: 'managed'; accountId: string } | { kind: 'system' }

/**
 * The saved Claude account a ref names, or null when none matches (an unknown ref never launches
 * under a guessed account). Order: id, then email, then label; email and label ignore case. A
 * label or email shared by two accounts is ambiguous and matches neither.
 */
export function resolveClaudeAccountRef(
  ref: string,
  accounts: readonly ClaudeManagedAccount[],
  names?: ManagedAccountDisplayNames | null
): ResolvedLaunchAccount | null {
  const wanted = ref.trim()
  if (wanted.toLowerCase() === LAUNCH_ACCOUNT_SYSTEM) {
    return { kind: 'system' }
  }
  const byId = accounts.find((account) => account.id === wanted)
  if (byId) {
    return { kind: 'managed', accountId: byId.id }
  }
  const lower = wanted.toLowerCase()
  const only = (matches: ClaudeManagedAccount[]): ResolvedLaunchAccount | null =>
    matches.length === 1 ? { kind: 'managed', accountId: matches[0].id } : null
  const byEmail = accounts.filter((account) => account.email.toLowerCase() === lower)
  if (byEmail.length > 0) {
    return only(byEmail)
  }
  return only(
    accounts.filter(
      (account) =>
        getManagedAccountDisplayName(names, 'claude', account.id)?.toLowerCase() === lower
    )
  )
}

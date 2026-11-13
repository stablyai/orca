export type ManagedAccountNameProvider = 'claude' | 'codex'

/** User-chosen account names by saved account id; kept apart from account records so a rename never reads as a launch change. */
export type ManagedAccountDisplayNames = Partial<
  Record<ManagedAccountNameProvider, Record<string, string>>
>

export type ManagedAccountNameSettings = {
  /** Absent means every saved Claude/Codex account shows its sign-in email. */
  managedAccountDisplayNames?: ManagedAccountDisplayNames
}

export const MANAGED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 120

export const MANAGED_ACCOUNT_DISPLAY_NAME_TOO_LONG_MESSAGE = `Account names can be at most ${MANAGED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH} characters.`

/** Blank clears the name; the account then shows its sign-in email. */
export function normalizeManagedAccountDisplayName(
  input: string | null | undefined
): string | null {
  const trimmed = (input ?? '').trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.length > MANAGED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(MANAGED_ACCOUNT_DISPLAY_NAME_TOO_LONG_MESSAGE)
  }
  return trimmed
}

export function getManagedAccountDisplayName(
  names: ManagedAccountDisplayNames | null | undefined,
  provider: ManagedAccountNameProvider,
  accountId: string
): string | undefined {
  const name = names?.[provider]?.[accountId]
  return typeof name === 'string' && name.trim() ? name : undefined
}

/** The next names map, or null when nothing changes (so callers skip the write). */
export function withManagedAccountDisplayName(
  names: ManagedAccountDisplayNames | null | undefined,
  provider: ManagedAccountNameProvider,
  accountId: string,
  displayName: string | null
): ManagedAccountDisplayNames | null {
  const current = names?.[provider] ?? {}
  if ((current[accountId] ?? null) === displayName) {
    return null
  }
  const next = { ...current }
  if (displayName === null) {
    delete next[accountId]
  } else {
    next[accountId] = displayName
  }
  return { ...names, [provider]: next }
}

type NamedAccount = { email: string; displayName?: string | null }

type NamedManagedAccount = { id: string; email: string; displayName?: string }

/** The names a user may call each account by; callers refuse a name several accounts share. */
export function getManagedAccountLookupNames(
  accounts: readonly NamedManagedAccount[]
): { id: string; names: (string | undefined)[] }[] {
  return accounts.map(({ id, email, displayName }) => ({ id, names: [email, displayName] }))
}

/** Two-line rows: the name leads and the email sits on the second line. */
export function getManagedAccountPrimaryLabel(account: NamedAccount): string {
  return account.displayName?.trim() || account.email
}

/** One-line labels keep the sign-in email beside a name so a re-pointed account can't pass as another. */
export function getManagedAccountInlineLabel(account: NamedAccount): string {
  const name = account.displayName?.trim()
  return name && name !== account.email ? `${name} (${account.email})` : account.email
}

/** Applies a host's saved names to its account list; returns the same list when nothing differs. */
export function withManagedAccountDisplayNames<
  State extends { accounts: readonly { id: string; displayName?: string }[] }
>(
  state: State,
  names: ManagedAccountDisplayNames | null | undefined,
  provider: ManagedAccountNameProvider
): State {
  if (!names) {
    return state
  }
  let changed = false
  const accounts = state.accounts.map((account) => {
    const displayName = getManagedAccountDisplayName(names, provider, account.id)
    if (displayName === account.displayName) {
      return account
    }
    changed = true
    const { displayName: _previous, ...rest } = account
    return displayName ? { ...rest, displayName } : rest
  })
  return changed ? { ...state, accounts } : state
}

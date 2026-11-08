export type CursorSavedAccount = {
  id: string
  email: string | null
  displayName: string | null
  subject: string
  createdAt: number
  updatedAt: number
}

export type CursorSavedAccountsState = {
  /** False where Orca cannot switch the CLI sign-in (anything but macOS today). */
  supported: boolean
  accounts: CursorSavedAccount[]
  /** The saved account whose sign-in the CLI holds right now. */
  activeAccountId: string | null
  selectedAccountId: string | null
  /** Whether the CLI holds a sign-in that is not saved yet. */
  currentUnsaved: boolean
}

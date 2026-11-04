/** The pane's path to the which-account file the `claude` shell function re-reads on every launch. */
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'

/** Set beside every CLAUDE_CONFIG_DIR Orca injects, so its own value never reads as the user's. */
export const CLAUDE_INJECTED_CONFIG_DIR_ENV = 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'

/** The user's own CLAUDE_CONFIG_DIR an injected value replaced; System default restores it. */
export const CLAUDE_USER_CONFIG_DIR_ENV = 'ORCA_CLAUDE_USER_CONFIG_DIR'

/** The account (`--account`, `system` for System default) a terminal was launched on; set only on
 *  such launches, whose env the account selection must not replace. */
export const CLAUDE_LAUNCH_ACCOUNT_ENV = 'ORCA_CLAUDE_ACCOUNT'

/** `--account system`: System default for one launch, whatever account is selected. */
export const CLAUDE_SYSTEM_ACCOUNT = 'system'

export const CLAUDE_LAUNCH_ACCOUNT_HOST_ONLY_MESSAGE =
  "--account starts Claude on this host's own accounts; WSL and SSH terminals are not supported yet. Nothing was started."

export const CLAUDE_PROFILE_MISSING_MESSAGE =
  "The selected Claude account's folder is missing. Sign in to it again or choose another account."

export const CLAUDE_PROFILE_SETUP_FAILED_MESSAGE =
  'The selected Claude account could not be set up. Try again or choose another account.'

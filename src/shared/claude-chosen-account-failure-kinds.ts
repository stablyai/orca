/** Launch refusals for a named Claude account that is missing or cannot run on this host. */
export const CLAUDE_CHOSEN_ACCOUNT_FAILURE_KINDS = [
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'claudeAccountUnknown',
  'claudeAccountWslUnsupported'
] as const

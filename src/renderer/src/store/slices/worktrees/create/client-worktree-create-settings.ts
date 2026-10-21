import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

const CLIENT_WORKTREE_CREATE_SETTING_KEYS = [
  'nestWorkspaces',
  'refreshLocalBaseRefOnWorktreeCreate',
  'localBaseRefSuggestionDismissed'
] as const

/** Client-profile settings a remote host applies to this create instead of its own. */
export type ClientWorktreeCreateSettings = Partial<
  Pick<GlobalSettings, (typeof CLIENT_WORKTREE_CREATE_SETTING_KEYS)[number]>
>

export function pickClientWorktreeCreateSettings(
  settings: GlobalSettings | null | undefined
): ClientWorktreeCreateSettings {
  const picked: ClientWorktreeCreateSettings = {}
  for (const key of CLIENT_WORKTREE_CREATE_SETTING_KEYS) {
    const value = settings?.[key]
    if (typeof value === 'boolean') {
      picked[key] = value
    }
  }
  return picked
}

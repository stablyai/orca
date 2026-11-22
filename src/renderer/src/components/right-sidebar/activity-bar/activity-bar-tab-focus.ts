/** Whether a route change should move focus into the Agents search box. */
export function shouldFocusVaultSearchOnRoute(args: {
  open: boolean
  creatingWorktree: boolean
  tab: string
  effectiveTab: string
  settingsFocusRequested: boolean
  routeFocusesVaultSearch: boolean
}): boolean {
  return (
    args.open &&
    !args.creatingWorktree &&
    args.tab === 'vault' &&
    args.effectiveTab === 'vault' &&
    !args.settingsFocusRequested &&
    args.routeFocusesVaultSearch
  )
}

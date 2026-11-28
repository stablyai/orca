import { selectActivityInboxEnabled } from '@/lib/bots-enabled'

/**
 * Whether this activation shows the workspace list. Asked for, or with the Activity inbox on (rail and bots) a jump
 * you made (`navigationIntent: 'user-open'`: ⌘K, the workspace shortcuts, a card, a link) that reveals the workspace
 * in the sidebar: it lands on the workspace in Workspaces rather than leaving you in Activity. Background switches
 * (an agent creating a workspace, a capture restoring the last one) never move you out of Activity. Activity's own
 * rows and a bot's Home pass `revealInSidebar: false`, so they stay in Activity; with the inbox off nothing changes.
 */
export function showsWorkspaceList(
  state: Parameters<typeof selectActivityInboxEnabled>[0],
  opts:
    | { showWorkspaceList?: boolean; revealInSidebar?: boolean; navigationIntent?: 'user-open' }
    | undefined
): boolean {
  return (
    opts?.showWorkspaceList === true ||
    (opts?.navigationIntent === 'user-open' &&
      opts.revealInSidebar !== false &&
      selectActivityInboxEnabled(state))
  )
}

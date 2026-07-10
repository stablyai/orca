import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'

// Why: on SSH (re)connect, panes that never got a live PTY must remount and
// retry. Two shapes qualify: tabs with no ptyId at all (their spawn failed
// outright), and tabs still holding a deferred reattach session for this
// target — their restored wake-hint ptyId reads as live but nothing is
// attached. The deferred entry is consumed synchronously the moment a pane
// starts reattaching, so a remaining entry proves the tab is stranded (e.g.
// the user cancelled the passphrase prompt and connected later via Settings).
export function shouldRetryPaneSpawnOnSshReconnect(args: {
  targetId: string
  tabPtyId: string | null | undefined
  deferredSessionId: string | undefined
}): boolean {
  if (!args.tabPtyId) {
    return true
  }
  return (
    args.deferredSessionId != null &&
    parseAppSshPtyId(args.deferredSessionId)?.connectionId === args.targetId
  )
}

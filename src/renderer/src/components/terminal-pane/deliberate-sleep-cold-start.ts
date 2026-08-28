/**
 * Decides whether a pane that found nothing to attach to must stay cold instead of
 * spawning a PTY.
 *
 * Why: sleeping a workspace kills its PTYs but leaves its panes mounted, so their
 * deferred connect still runs on later render passes — including ones caused by
 * activating an unrelated workspace. Spawning there re-creates the PTY and silently
 * wakes the workspace the user just slept (#10205).
 */
export function shouldStayColdForDeliberateSleep(args: {
  /** A startup command targeted at this pane is an explicit request to launch. */
  hasQueuedStartup: boolean
  /** A visible pane must have a PTY, whatever the workspace's sleep state. */
  isPaneVisible: boolean
  /** Cleared by activation and by an explicit background wake. */
  hasSleepIntent: boolean
  activeWorktreeId: string | null
  worktreeId: string
}): boolean {
  if (args.hasQueuedStartup || args.isPaneVisible) {
    return false
  }
  if (!args.hasSleepIntent) {
    return false
  }
  return args.activeWorktreeId !== args.worktreeId
}

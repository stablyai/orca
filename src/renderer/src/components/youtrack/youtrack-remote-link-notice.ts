import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Upstream Orca servers don't know the YouTrack provider and drop the link when they store the worktree. */
export function warnYouTrackLinkOnRemoteServer(): void {
  toast.warning(
    translate(
      'youtrack.workspace.remoteLinkDropped',
      'This worktree runs on a remote Orca server, which may not keep its YouTrack link. The worktree is still created.'
    )
  )
}

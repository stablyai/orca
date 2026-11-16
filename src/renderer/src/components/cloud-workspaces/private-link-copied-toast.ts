// Copy link on a private cloud workspace. The link is on the clipboard, but a
// teammate who opens it is refused, so the toast says so and, for whoever can share it, offers
// Share with team right there (the same visibility change as the menu's Share with team).
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'
import { toastSharedWithTeam } from './shared-with-team-toast'

export async function shareCloudWorkspaceWithTeam(id: string): Promise<boolean> {
  const result = await window.api.cloudWorkspaces
    .patch(id, { visibility: 'team' })
    .catch(() => null)
  if (!result?.ok) {
    toast.error(
      translate(
        'auto.components.cloudWorkspaces.shareFailed',
        'Couldn’t change who can open it. Try again.'
      )
    )
    return false
  }
  rememberCloudWorkspaces([result.value])
  toastSharedWithTeam(translate)
  return true
}

export const privateLinkToastId = (id: string): string => `private-link-copied:${id}`

export function toastPrivateLinkCopied(id: string, chat: boolean, canShare: boolean): void {
  // An access fact, not a failure: the warning tone, like the access-lost notice.
  toast.warning(
    chat
      ? translate(
          'auto.components.cloudWorkspaces.privateChatLinkCopied',
          'Chat link copied, but teammates can’t open it yet'
        )
      : translate(
          'auto.components.cloudWorkspaces.privateLinkCopied',
          'Link copied, but teammates can’t open it yet'
        ),
    {
      // One per workspace: copying again replaces it instead of stacking.
      id: privateLinkToastId(id),
      description: canShare
        ? translate(
            'auto.components.cloudWorkspaces.privateLinkShareHint',
            'This workspace is private. Share it with your team so the link works for them.'
          )
        : translate(
            'auto.components.cloudWorkspaces.privateLinkOwnerHint',
            'This workspace is private. Only its owner can share it with the team.'
          ),
      ...(canShare
        ? {
            action: {
              label: translate('auto.components.cloudWorkspaces.shareWithTeam', 'Share with team'),
              onClick: () => void shareCloudWorkspaceWithTeam(id)
            }
          }
        : {})
    }
  )
}

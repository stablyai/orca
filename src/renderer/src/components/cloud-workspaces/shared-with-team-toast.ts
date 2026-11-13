import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'

/**
 * "Shared with your team", with the one thing that changes for the owner (SEC-5): their personal
 * secrets stop being injected once teammates can open the workspace.
 */
export function toastSharedWithTeam(t: Translate): void {
  toast.success(t('auto.components.cloudWorkspaces.sharedWithYourTeam', 'Shared with your team'), {
    description: t(
      'auto.components.cloudWorkspaces.sharedPersonalSecretsNote',
      'Your personal cloud secrets aren’t used in shared workspaces. Shared and repository secrets still are.'
    )
  })
}

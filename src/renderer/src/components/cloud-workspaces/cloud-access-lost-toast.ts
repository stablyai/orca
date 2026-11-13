// EP-8: this computer's pairing to a cloud workspace was refused and Orca Cloud won't grant it again:
// the account can no longer open the workspace (it was made private, reassigned, or the member
// removed). Say so once, with the one fix: remove it from this computer. Other devices aren't affected.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const shown = new Set<string>()

export function showCloudAccessLostToast(
  lost: { environmentId: string; sandboxId: string },
  remove: (environmentId: string) => Promise<unknown>
): void {
  if (shown.has(lost.environmentId)) {
    return
  }
  shown.add(lost.environmentId)
  // An access change, not a failure: the warning tone (glossary: red only for real errors).
  toast.warning(translate('cloudAccessLost.title', 'You can’t open this cloud workspace anymore'), {
    id: `cloud-access-lost:${lost.environmentId}`,
    duration: Infinity,
    description: translate(
      'cloudAccessLost.description',
      'Its owner or a team admin changed who can open it. Ask them for access, or remove it from this computer. This doesn’t delete the workspace.'
    ),
    action: {
      label: translate('cloudAccessLost.remove', 'Remove from this computer'),
      onClick: () => {
        void remove(lost.environmentId).catch(() => {
          shown.delete(lost.environmentId)
        })
      }
    }
  })
}

export function installCloudAccessLostNotice(): () => void {
  const api = window.api?.cloudWorkspaces
  if (!api?.onAccessLost) {
    return () => {}
  }
  return api.onAccessLost((lost) =>
    showCloudAccessLostToast(lost, (environmentId) =>
      window.api.runtimeEnvironments.remove({ selector: environmentId })
    )
  )
}

/** Tests only. */
export function resetCloudAccessLostToastsForTests(): void {
  shown.clear()
}

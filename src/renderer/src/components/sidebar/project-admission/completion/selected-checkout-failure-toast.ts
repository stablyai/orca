import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { projectAddToastId } from '@/store/repos/repo-state'

export type SelectedCheckoutFailure =
  | { kind: 'owner_unavailable' }
  | { kind: 'save_failed' | 'missing'; retry: () => void }
  | { kind: 'refresh_failed'; hostLabel: string; retry: () => void }

function describe(failure: SelectedCheckoutFailure): string {
  switch (failure.kind) {
    case 'owner_unavailable':
      return translate(
        'projectAdmission.checkout.ownerUnavailable',
        'The project host could not be identified. Add the project again from the intended host.'
      )
    case 'save_failed':
      return translate(
        'projectAdmission.checkout.saveFailed',
        'Could not save the selected checkout’s visibility. Retry to open it.'
      )
    case 'missing':
      return translate(
        'projectAdmission.checkout.missing',
        'The selected folder could not be matched to an available checkout on this host.'
      )
    case 'refresh_failed':
      return translate(
        'projectAdmission.checkout.refreshFailed',
        'Could not refresh checkouts on {{host}}. Retry when the host is available.',
        { host: failure.hostLabel }
      )
  }
}

/** Replaces the add's own toast, so one add never reports both "added" and this failure. */
export function showSelectedCheckoutFailure(
  repoId: string,
  failure: SelectedCheckoutFailure
): void {
  toast.error(
    translate('projectAdmission.checkout.openFailed', 'Could not open selected checkout'),
    {
      id: projectAddToastId(repoId),
      description: describe(failure),
      ...('retry' in failure
        ? { action: { label: translate('common.retry', 'Retry'), onClick: failure.retry } }
        : {})
    }
  )
}

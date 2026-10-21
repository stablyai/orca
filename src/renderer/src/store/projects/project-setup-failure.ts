import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'

/** A caller that shows its own failure gets the cause here instead of a toast. */
export type ProjectSetupFailureOptions = { onError?: (message: string) => void }

export function reportProjectSetupFailure(
  err: unknown,
  options: ProjectSetupFailureOptions | undefined
): void {
  const message = err instanceof Error ? err.message : String(err)
  if (options?.onError) {
    options.onError(message)
    return
  }
  toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
    description: message,
    duration: ERROR_TOAST_DURATION
  })
}

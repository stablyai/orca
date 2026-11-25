import { toast } from 'sonner'

type MutationResult = { ok: true } | { ok: false; error: string }

/** Runs a Gitea write and its follow-up reads; toasts any failure and never throws. */
export async function runGiteaMutation(
  run: () => Promise<MutationResult>,
  fallbackError: string
): Promise<boolean> {
  try {
    const result = await run()
    if (!result.ok) {
      toast.error(result.error)
    }
    return result.ok
  } catch (error) {
    toast.error(error instanceof Error ? error.message : fallbackError)
    return false
  }
}

/** Re-reads after an accepted write; a failed read is reported without undoing that write. */
export function refreshAfterGiteaWrite<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  refreshFailedMessage: string
): void {
  void read().then(apply, () => toast.error(refreshFailedMessage))
}

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

/** Wraps a setter so that, of overlapping reads started on one counter, only the newest applies. */
export function newestReadOnly<T>(
  counter: { current: number },
  apply: (value: T) => void
): (value: T) => void {
  counter.current += 1
  const readId = counter.current
  return (value) => {
    if (readId === counter.current) {
      apply(value)
    }
  }
}

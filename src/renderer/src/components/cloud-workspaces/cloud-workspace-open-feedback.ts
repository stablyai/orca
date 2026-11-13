// EP-6-FLAKE: opening a cloud workspace can wait a long while (a wake, a just-created VM, a grant
// that times out) with nothing on screen, then drop the person on Home. While an open runs, a
// loading toast says so after a few seconds; a timeout says it is still starting (Try again); a
// workspace the server no longer has fails at once (Couldn't find it). The picker shows its own
// spinner on the row, so the toast waits while that row is on screen and shows at once if the
// picker closes mid-open.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export const OPEN_FEEDBACK_DELAY_MS = 3_000

export type OpenFeedbackFailure = 'timeout' | 'gone'

type Flight = {
  name: string
  timer: ReturnType<typeof setTimeout> | null
  shown: boolean
}

const flights = new Map<string, Flight>()
// Workspaces whose open the picker is showing (its row spinner), counted per mount.
const pickerShown = new Map<string, number>()

function toastId(workspaceId: string): string {
  return `cloud-workspace-open:${workspaceId}`
}

function showLoading(workspaceId: string, flight: Flight): void {
  if (flight.shown) {
    return
  }
  flight.shown = true
  toast.loading(
    translate('cloudWorkspaceOpen.opening', 'Opening {{name}}…', { name: flight.name }),
    {
      id: toastId(workspaceId),
      duration: Infinity,
      description: translate(
        'cloudWorkspaceOpen.openingDescription',
        'Workspaces that were asleep or just created can take a minute or two.'
      )
    }
  )
}

/** An open began: after the delay, a loading toast unless the picker row shows the open. */
export function beginCloudWorkspaceOpenFeedback(workspaceId: string, name: string): void {
  endFlight(workspaceId)
  const flight: Flight = { name, timer: null, shown: false }
  flight.timer = setTimeout(() => {
    flight.timer = null
    if (!pickerShown.get(workspaceId)) {
      showLoading(workspaceId, flight)
    }
  }, OPEN_FEEDBACK_DELAY_MS)
  flights.set(workspaceId, flight)
}

function endFlight(workspaceId: string): Flight | undefined {
  const flight = flights.get(workspaceId)
  if (flight?.timer) {
    clearTimeout(flight.timer)
  }
  flights.delete(workspaceId)
  return flight
}

/**
 * The open settled. A timeout or a missing workspace gets its own toast (true: the caller shows
 * nothing more); anything else only clears the loading toast and leaves the message to the caller.
 */
export function endCloudWorkspaceOpenFeedback(
  workspaceId: string,
  outcome: { ok: true } | { ok: false; failure?: OpenFeedbackFailure },
  actions: { retry: () => void; showWorkspaces: () => void }
): boolean {
  const flight = endFlight(workspaceId)
  const name = flight?.name ?? ''
  const id = toastId(workspaceId)
  if (outcome.ok || !outcome.failure) {
    if (flight?.shown) {
      toast.dismiss(id)
    }
    return false
  }
  if (outcome.failure === 'timeout') {
    // Still starting, not failed: the warning tone.
    toast.warning(
      translate('cloudWorkspaceOpen.slowTitle', '{{name}} is taking longer than usual', { name }),
      {
        id,
        duration: Infinity,
        description: translate(
          'cloudWorkspaceOpen.slowDescription',
          'It’s still starting. Try again in a moment.'
        ),
        action: {
          label: translate('cloudWorkspaceOpen.tryAgain', 'Try again'),
          onClick: actions.retry
        }
      }
    )
    return true
  }
  toast.error(translate('cloudWorkspaceOpen.goneTitle', 'Couldn’t find {{name}}', { name }), {
    id,
    description: translate('cloudWorkspaceOpen.goneDescription', 'It may have been deleted.'),
    action: {
      label: translate(
        'auto.components.cloudWorkspaces.showCloudWorkspaces',
        'Show cloud workspaces'
      ),
      onClick: actions.showWorkspaces
    }
  })
  return true
}

/** Runs an open with its feedback; a failure a toast already explained comes back `notified`. */
export async function withCloudWorkspaceOpenFeedback<
  T extends { ok: true } | { ok: false; failure?: OpenFeedbackFailure; notified?: true }
>(
  workspaceId: string,
  name: string,
  run: () => Promise<T>,
  actions: { retry: () => void; showWorkspaces: () => void }
): Promise<T> {
  beginCloudWorkspaceOpenFeedback(workspaceId, name)
  let outcome: T
  try {
    outcome = await run()
  } catch (error) {
    endCloudWorkspaceOpenFeedback(workspaceId, { ok: false }, actions)
    throw error
  }
  const notified = endCloudWorkspaceOpenFeedback(workspaceId, outcome, actions)
  return notified && !outcome.ok ? { ...outcome, notified: true } : outcome
}

/**
 * The picker shows this workspace's open on its row while mounted. Returns the release: when the
 * picker closes mid-open past the delay, the loading toast shows at once.
 */
export function showCloudWorkspaceOpenInPicker(workspaceId: string): () => void {
  pickerShown.set(workspaceId, (pickerShown.get(workspaceId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const left = (pickerShown.get(workspaceId) ?? 1) - 1
    if (left > 0) {
      pickerShown.set(workspaceId, left)
      return
    }
    pickerShown.delete(workspaceId)
    const flight = flights.get(workspaceId)
    if (flight) {
      // Closed mid-open: say so now, without restarting the delay.
      if (flight.timer) {
        clearTimeout(flight.timer)
        flight.timer = null
      }
      showLoading(workspaceId, flight)
    }
  }
}

/** Tests only. */
export function resetCloudWorkspaceOpenFeedbackForTests(): void {
  for (const flight of flights.values()) {
    if (flight.timer) {
      clearTimeout(flight.timer)
    }
  }
  flights.clear()
  pickerShown.clear()
}

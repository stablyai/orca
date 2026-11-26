type ConfirmLeave = (signal: AbortSignal) => Promise<boolean>

type Registration = { confirmLeave: ConfirmLeave }

let current: Registration | null = null
let pending: { registration: Registration; controller: AbortController } | null = null

/**
 * Settings registers its discard check per mount (one registration = one Settings visit). Unregistering aborts a
 * confirmation still open for that visit, so it can't outlive Settings or block the next visit.
 */
export function registerSettingsLeaveGuard(confirmLeave: ConfirmLeave): () => void {
  const registration: Registration = { confirmLeave }
  current = registration
  return () => {
    if (pending?.registration === registration) {
      pending.controller.abort()
      pending = null
    }
    if (current === registration) {
      current = null
    }
  }
}

/**
 * Run `leave` only after this Settings visit approves (nothing unsaved, or Discard). Cancel, a request while a
 * confirmation is open, or an approval that arrives after the visit ended runs nothing.
 */
export async function leaveSettingsThen(
  isOnSettings: () => boolean,
  leave: () => void
): Promise<void> {
  const registration = current
  if (!isOnSettings() || !registration) {
    leave()
    return
  }
  if (pending) {
    return
  }
  const controller = new AbortController()
  const request = { registration, controller }
  pending = request
  let approved = false
  try {
    approved = await registration.confirmLeave(controller.signal)
  } finally {
    if (pending === request) {
      pending = null
    }
  }
  if (approved && !controller.signal.aborted && current === registration && isOnSettings()) {
    leave()
  }
}

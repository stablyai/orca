import { useEffect, useSyncExternalStore } from 'react'
import type { CopilotCompletionApi } from '../../../../preload/api/copilot-completion-api'
import type { CopilotStatus } from '../../../../shared/copilot-inline-completion-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'

/** Copilot server status for the status bar and editor attachment. */
let status: CopilotStatus | null = null
const listeners = new Set<() => void>()
let unsubscribeStatus: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Asks main whether the server is installed; runs while none is known so a mid-session install shows up. */
function refreshInstalledStatus(api: CopilotCompletionApi): void {
  if (status?.installed) {
    return
  }
  void api
    .status()
    .then((next) => {
      // Why: a pushed status may have landed while this was in flight, and it always reports installed.
      if (!status?.installed) {
        status = next
        emit()
      }
    })
    .catch(() => {})
}

export function ensureCopilotStatusSubscription(): void {
  // Why: the paired web client has no Copilot bridge; its API stub answers every call with undefined.
  const api = isPairedWebClientWindow() ? undefined : window.api?.copilotCompletion
  if (unsubscribeStatus || !api?.onStatus) {
    return
  }
  unsubscribeStatus = api.onStatus((next) => {
    const signInJustFailed = next.signInFailed && !status?.signInFailed
    status = next
    emit()
    if (signInJustFailed) {
      toast.error(
        translate(
          'auto.components.status.bar.CopilotStatusSegment.signInFailed',
          'Copilot sign-in failed'
        )
      )
    }
  })
  refreshInstalledStatus(api)
  // Why: installing the server mid-session has no event; main re-probes PATH at most once a minute, so focus is a cheap trigger.
  window.addEventListener('focus', () => refreshInstalledStatus(api))
}

/** Merges into the live status so a concurrent push (e.g. main clearing `signInFailed`) isn't overwritten. */
export function patchCopilotStatus(patch: Partial<CopilotStatus>): void {
  if (status) {
    status = { ...status, ...patch }
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Status whenever the server is installed, independent of the active tab, so
 *  sign-in stays reachable before any file is opened. Null when not installed. */
export function getInstalledCopilotStatus(): CopilotStatus | null {
  return status?.installed ? status : null
}

export function useCopilotStatus(): CopilotStatus | null {
  useEffect(ensureCopilotStatusSubscription, [])
  return useSyncExternalStore(subscribe, getInstalledCopilotStatus)
}

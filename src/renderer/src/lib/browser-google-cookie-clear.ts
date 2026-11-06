import { toast } from 'sonner'
import type {
  GoogleCookieClearTarget,
  GoogleCookieClearResult
} from '../../../shared/browser-google-cookie-clear'
import { BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY } from '../../../shared/browser-runtime-capabilities'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

function remoteGoogleCookieClearAvailable(environmentId: string): boolean {
  const state = useAppStore.getState()
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  return (
    !!environment &&
    state.runtimeStatusByEnvironmentId
      .get(environmentId)
      ?.status?.capabilities?.includes(BROWSER_GOOGLE_COOKIE_CLEAR_CAPABILITY) === true
  )
}

export async function captureGoogleCookieClearTarget(
  hostId: ExecutionHostId,
  profileId: string,
  label: string | undefined,
  remote: boolean,
  pairingRevision?: number
) {
  const state = useAppStore.getState()
  const parsedHost = parseExecutionHostId(hostId)
  const environmentId = parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
  pairingRevision ??= environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const targetLabel = label || (profileId === 'default' ? 'Default' : profileId)
  const local = await window.api.browser.sessionGoogleCookieClearTarget({
    profileId,
    environmentId
  })
  if (
    environmentId &&
    (pairingRevision === undefined ||
      getRuntimeEnvironmentRevision(environmentId) !== pairingRevision)
  ) {
    throw new Error('Google cookie destination changed')
  }
  if (local !== null) {
    return {
      available: true,
      target: { local, label: targetLabel }
    }
  }
  if (!environmentId || !remoteGoogleCookieClearAvailable(environmentId)) {
    return { available: false }
  }
  if (!remote) {
    return { available: true }
  }
  const observation = await state.fetchBrowserSessionProfiles(hostId)
  const profile = observation?.profiles.find((entry) => entry.id === profileId)
  if (
    !observation ||
    !profile ||
    !observation.executorRuntimeId ||
    typeof observation.pairingRevision !== 'number' ||
    observation.pairingRevision !== pairingRevision ||
    getRuntimeEnvironmentRevision(environmentId) !== pairingRevision ||
    !remoteGoogleCookieClearAvailable(environmentId)
  ) {
    return { available: false }
  }
  return {
    available: true,
    target: {
      environmentId,
      profileId,
      label: targetLabel,
      pairingRevision: observation.pairingRevision,
      executorRuntimeId: observation.executorRuntimeId
    }
  }
}

export async function confirmAndClearGoogleCookies(
  target: GoogleCookieClearTarget,
  confirm: ConfirmationDialogContextValue
): Promise<void> {
  const profileId = 'local' in target ? target.local.profileId : target.profileId
  const values = {
    profile: target.label || (profileId === 'default' ? 'Default' : 'Browser profile')
  }
  if (
    !(await confirm({
      title: translate(
        'browser.googleCookieClear.confirmTitle',
        'Clear Google cookies from {{profile}}?',
        values
      ),
      description: translate(
        'browser.googleCookieClear.confirmDescription',
        "You'll be signed out of Google in Orca's browser for this profile. Other sites stay signed in."
      ),
      confirmLabel: translate('browser.googleCookieClear.clear', 'Clear'),
      cancelLabel: translate('browser.googleCookieClear.cancel', 'Cancel'),
      confirmVariant: 'destructive'
    }))
  ) {
    return
  }
  let result: GoogleCookieClearResult = 'unverified'
  try {
    result =
      'local' in target
        ? await window.api.browser.sessionClearGoogleCookies(target.local)
        : await callRuntimeRpc<GoogleCookieClearResult>(
            { kind: 'environment', environmentId: target.environmentId },
            'browser.profileClearGoogleCookies',
            { profileId: target.profileId, executorRuntimeId: target.executorRuntimeId },
            {
              expectedEnvironmentPairingRevision: target.pairingRevision
            }
          )
  } catch {
    /* The result below also covers a disconnected or replaced destination. */
  }
  const messages: Record<GoogleCookieClearResult, string> = {
    cleared: translate(
      'browser.googleCookieClear.cleared',
      'Google cookies cleared from {{profile}}.',
      values
    ),
    empty: translate(
      'browser.googleCookieClear.empty',
      'No Google cookies to clear in {{profile}}.',
      values
    ),
    remaining: translate(
      'browser.googleCookieClear.remaining',
      "Some Google cookies couldn't be removed from {{profile}}. Try again.",
      values
    ),
    unverified: translate(
      'browser.googleCookieClear.unverified',
      "Couldn't check {{profile}}'s Google cookies. Try again.",
      values
    )
  }
  const message = messages[result] ?? messages.unverified
  if (result === 'cleared' || result === 'empty') {
    toast.success(message)
  } else {
    toast.error(message)
  }
}

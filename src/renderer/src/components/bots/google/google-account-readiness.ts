import { useEffect } from 'react'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GoogleAccountView } from '../../../../../shared/google/google-connect-types'
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICE_CHOICES,
  googleApiEnableUrl,
  type GoogleServiceChoice
} from '../../../../../shared/google/google-scopes'
import { withGoogleAccount } from '../../../../../shared/google/google-console-setup'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { refreshGoogle } from './google-connect-client'
import { googleAdminRequest, googleReadinessFace } from './google-copy'

// A newly turned-on API can take a few minutes to answer, so leftovers are read again on their own.
const RECHECK_EVERY_MS = 30_000
const RECHECK_FOR_MS = 10 * 60_000

/** The choices this account signed in with, read from the services it checks. */
export function googleAccountChoices(account: GoogleAccountView): GoogleServiceChoice[] {
  const services = new Set(account.services.map((entry) => entry.service))
  return GOOGLE_SERVICE_CHOICES.filter((choice) =>
    GOOGLE_CHOICE_SERVICES[choice].some((service) => services.has(service))
  )
}

/**
 * What a sign-in asks Google for: what the account has, else every service. An account this host
 * can't read lists no services, and a sign-in must ask for at least one.
 */
export function googleSignInChoices(account: GoogleAccountView | undefined): GoogleServiceChoice[] {
  const choices = account ? googleAccountChoices(account) : []
  return choices.length > 0 ? choices : [...GOOGLE_SERVICE_CHOICES]
}

/** Checks the account's leftovers again every 30 s while shown, for ten minutes. */
export function useRecheckWhileBroken(target: RuntimeClientTarget, broken: boolean): void {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    if (!broken) {
      return undefined
    }
    const until = Date.now() + RECHECK_FOR_MS
    const timer = setInterval(() => {
      if (Date.now() > until) {
        clearInterval(timer)
        return
      }
      void refreshGoogle(runtimeTargetForOwnerEnvironment(environmentId), {
        check: true
      })
    }, RECHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [broken, environmentId])
}

/** The one action that fixes a service's readiness, as its row's button runs it. */
export function googleReadinessFixer({
  target,
  account,
  clientId,
  projectId,
  onAllowAgain
}: {
  target: RuntimeClientTarget
  account: GoogleAccountView
  clientId: string | null
  projectId: string | null
  onAllowAgain: (choices: GoogleServiceChoice[]) => void
}): (entry: GoogleAccountView['services'][number]) => void {
  return (entry) => {
    switch (googleReadinessFace(entry).fix) {
      case 'turn-on':
        openAppHttpLink(
          withGoogleAccount(
            entry.enableUrl ?? googleApiEnableUrl(entry.service, projectId ?? undefined),
            account.email
          )
        )
        return
      case 'allow-again':
        onAllowAgain(googleAccountChoices(account))
        return
      case 'copy-for-admin':
        if (clientId) {
          void window.api.ui
            .writeClipboardText(googleAdminRequest(clientId))
            .then(() =>
              toast.success(
                translate('bots.google.copied', 'Copied. Send it to your Google admin.')
              )
            )
        }
        return
      case 'check-again':
        void refreshGoogle(target, { check: true })
        break
      case null:
        break
    }
  }
}

import React, { useEffect } from 'react'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { Check, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
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
import {
  googleAccountHeadline,
  googleAdminRequest,
  googleFixLabel,
  googleProblems,
  googleReadinessFace,
  googleReadinessRows
} from './google-copy'

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

/** Checks the account's leftovers again every 30 s while shown, for ten minutes. */
function useRecheckWhileBroken(target: RuntimeClientTarget, broken: boolean): void {
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

/** One account's headline and a row per service, each with the one action that fixes it. */
export function GoogleAccountReadiness({
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
}): React.JSX.Element {
  const t = useTranslate()
  const problems = googleProblems(account)
  // Only an API being turned on changes without the person; a missing permission waits for them.
  const waitingOnGoogle = problems.some((row) => row.readiness.state === 'api-disabled')
  useRecheckWhileBroken(target, account.status === 'connected' && waitingOnGoogle)
  // Name lookup comes with every service; it gets a row only when it needs something.
  const rows = googleReadinessRows(account).filter(
    (row) => row.key !== 'contacts' || row.readiness.state !== 'ready'
  )

  const fix = googleReadinessFixer({ target, account, clientId, projectId, onAllowAgain })

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{googleAccountHeadline(account)}</p>
      {account.status === 'connected' ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map(({ key, label, readiness: entry }) => {
            const face = googleReadinessFace(entry)
            return (
              <li key={key} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                {entry.state === 'ready' ? (
                  <Check className="size-4 shrink-0 text-status-success" aria-hidden />
                ) : (
                  <Minus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="truncate text-xs text-muted-foreground">{face.label}</span>
                {face.fix ? (
                  <Button size="xs" variant="outline" onClick={() => fix(entry)}>
                    {googleFixLabel(face.fix)}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {account.status === 'connected' && waitingOnGoogle ? (
        <p className="text-xs text-muted-foreground">
          {t('bots.google.checksAgain', 'Orca checks again on its own.')}
        </p>
      ) : null}
    </div>
  )
}

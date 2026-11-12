// V3-08: signed out of Orca in a build that offers Orca Cloud, Home says where the team's cloud
// workspaces went and how to see them, in the place the cloud list would be. Local builds and
// signed-in people never see it. While it shows, it stands in for the trial card (one cloud card).
import React from 'react'
import { Cloud } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../OrcaSignInProgress'

/** Signed out of an Orca account this build can sign in to: never signed in, or the session ended. */
export function isSignedOutOfOrcaCloud(
  cloudAvailable: boolean | null,
  status: OrcaProfileAuthStatus | null | undefined
): boolean {
  return (
    cloudAvailable === true &&
    status?.configured === true &&
    (status.state === 'local' || status.state === 'reconnect-required')
  )
}

export function useSignedOutOfOrcaCloud(): boolean {
  const available = useCloudWorkspacesAvailable()
  const status = useAppStore((s) => s.orcaProfileAuthStatus)
  return isSignedOutOfOrcaCloud(available, status)
}

/** Render only when `useSignedOutOfOrcaCloud()` holds (Landing decides; fixtures render it directly). */
export function LandingCloudSignInCard({
  reconnect
}: {
  /** The session ended (`reconnect-required`), as opposed to never signed in. */
  reconnect: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section
      aria-labelledby="landing-cloud-sign-in-title"
      data-landing-cloud-sign-in="true"
      className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left"
    >
      <div className="flex items-start gap-3">
        <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="landing-cloud-sign-in-title" className="text-sm font-medium text-foreground">
            {t('components.landing.cloudSignIn.title', 'Cloud workspaces')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'components.landing.cloudSignIn.body',
              'Sign in to see your team’s cloud workspaces.'
            )}
          </p>
          <div className="mt-3 flex flex-col items-start gap-2">
            <OrcaSignInButton size="sm" variant="outline">
              {reconnect
                ? t('components.landing.cloudSignIn.again', 'Sign in again')
                : t('components.landing.cloudSignIn.action', 'Sign in')}
            </OrcaSignInButton>
            <OrcaSignInWaitNotice />
          </div>
        </div>
      </div>
    </section>
  )
}

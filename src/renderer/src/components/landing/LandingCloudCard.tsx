// Landing's first-run Orca Cloud card (spec E2): the one place a new user learns the trial exists.
// Shown while the build offers Orca Cloud, this profile has never started a cloud workspace, and the
// card hasn't been dismissed. Once the team's trial is used up it hides. Hours from billing; no price.
import React, { useState } from 'react'
import { Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-billing-cache'
import type { OrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-run-target-access'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import { openNewCloudWorkspace } from '@/hooks/ipc-events/new-workspace-command'
import { readRunOnMemory } from '@/lib/orca-cloud/run-on-memory'

const DISMISS_KEY_PREFIX = 'orca.landing.cloudCard.dismissed.v1'

function dismissKey(profileId: string | null): string {
  return `${DISMISS_KEY_PREFIX}:${profileId ?? 'default'}`
}

export function isLandingCloudCardDismissed(
  profileId: string | null,
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage
): boolean {
  try {
    return storage?.getItem(dismissKey(profileId)) === '1'
  } catch {
    return false
  }
}

export function LandingCloudCard({
  cloudWorkspacesPresent,
  accessOverride
}: {
  /** Signed in with Orca Cloud: the account can already open cloud workspaces, so no pitch. */
  cloudWorkspacesPresent: boolean
  /** Fixtures pin the account's access. */
  accessOverride?: OrcaCloudRunTargetAccess
}): React.JSX.Element | null {
  const t = useTranslate()
  const available = useCloudWorkspacesAvailable()
  const profileId = useAppStore((s) => s.activeOrcaProfileId ?? null)
  const fetched = useOrcaCloudRunTargetAccess(available === true && !accessOverride)
  const access = accessOverride ?? fetched
  const [dismissed, setDismissed] = useState(() => isLandingCloudCardDismissed(profileId))
  const usedCloud = readRunOnMemory(profileId, '').globalLast === 'orca-cloud'
  // A team past its trial with no plan, or blocked on billing, has nothing to try here.
  const blocked =
    (access.state === 'no-plan' && !access.trialOfferSeconds) ||
    access.state === 'out-of-hours' ||
    access.state === 'payment-issue'
  if (available !== true || dismissed || usedCloud || cloudWorkspacesPresent || blocked) {
    return null
  }
  const trialHours =
    access.state === 'no-plan' && access.trialOfferSeconds
      ? Math.round((access.trialOfferSeconds / 3600) * 10) / 10
      : null
  const title =
    trialHours !== null
      ? t(
          'components.newWorkspace.cloudSetup.trialOffer',
          '{{hours}} sandbox hours to try Orca Cloud',
          {
            count: trialHours,
            hours: String(trialHours),
            defaultValue_one: '{{hours}} sandbox hour to try Orca Cloud'
          }
        )
      : access.state === 'entitled'
        ? t('components.landing.cloudCard.title', 'Run agents in Orca Cloud')
        : t('components.landing.cloudCard.tryTitle', 'Try Orca Cloud')
  const dismiss = (): void => {
    try {
      localStorage.setItem(dismissKey(profileId), '1')
    } catch {
      // Private mode: hide for this session only.
    }
    setDismissed(true)
  }
  return (
    <section
      aria-labelledby="landing-cloud-card-title"
      data-landing-cloud-card="true"
      className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left"
    >
      <div className="flex items-start gap-3">
        <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="landing-cloud-card-title" className="text-sm font-medium text-foreground">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {access.state === 'entitled'
              ? t(
                  'components.landing.cloudCard.planBody',
                  'Agents keep running while your laptop sleeps.'
                )
              : t(
                  'components.landing.cloudCard.trialBody',
                  'Agents keep running while your laptop sleeps. No card needed.'
                )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => openNewCloudWorkspace(useAppStore.getState(), 'unknown')}
            >
              {t('components.landing.cloudCard.try', 'Try Orca Cloud')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              {t('components.landing.cloudCard.notNow', 'Not now')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

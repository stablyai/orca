// Landing's first-run Orca Cloud card (spec E3): shown while the build offers Orca Cloud, this
// profile has never started a cloud workspace, and the card hasn't been dismissed. No price.
import React, { useState } from 'react'
import { Cloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
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
  cloudWorkspacesPresent
}: {
  /** The account already has cloud workspaces listed below: the card has done its job. */
  cloudWorkspacesPresent: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const available = useCloudWorkspacesAvailable()
  const profileId = useAppStore((s) => s.activeOrcaProfileId ?? null)
  const keybindings = useAppStore((s) => s.keybindings)
  const [dismissed, setDismissed] = useState(() => isLandingCloudCardDismissed(profileId))
  const usedCloud = readRunOnMemory(profileId, '').globalLast === 'orca-cloud'
  if (available !== true || dismissed || usedCloud || cloudWorkspacesPresent) {
    return null
  }
  const shortcut = formatOptionalPrimaryShortcutLabel('workspace.createCloud', keybindings)
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
            {t('components.landing.cloudCard.title', 'Run agents in Orca Cloud')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'components.landing.cloudCard.body',
              'Hosted sandboxes keep running while your laptop sleeps. Start one from any project.'
            )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="text-xs"
              onClick={() => openNewCloudWorkspace(useAppStore.getState(), 'unknown')}
            >
              {t('keybindings.title.workspaceCreateCloud', 'New cloud workspace')}
              {shortcut ? (
                <span className="ml-1 text-primary-foreground/70">{shortcut}</span>
              ) : null}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="text-xs" onClick={dismiss}>
              {t('components.landing.cloudCard.notNow', 'Not now')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

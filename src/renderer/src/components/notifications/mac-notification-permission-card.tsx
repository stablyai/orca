import { useEffect, useState } from 'react'
import { BellRing, Check, Settings, TriangleAlert } from 'lucide-react'
import type { NotificationDeliveryProbeResult } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type MacNotificationPermissionState =
  | 'checking'
  | 'awaiting-permission'
  | 'enabled'
  | 'blocked'

const MAC_PROBE_POLL_INTERVAL_MS = 2500
// Why: bounded so an abandoned onboarding tab doesn't probe forever; ~3
// minutes comfortably covers answering the dialog or flipping the toggle
// in System Settings.
const MAC_PROBE_POLL_MAX_ATTEMPTS = 72

export function resolveMacNotificationPermissionState(
  probeState: NotificationDeliveryProbeResult['state'],
  promptedBefore: boolean
): MacNotificationPermissionState | null {
  if (probeState === 'unsupported') {
    return null
  }
  if (probeState === 'delivered') {
    return 'enabled'
  }
  if (probeState === 'awaiting-decision') {
    return 'awaiting-permission'
  }
  // Why: probe-fallback hosts can't tell "unanswered dialog" from "denied" —
  // a first-ever probe is what makes macOS show the permission dialog, so
  // its rejection means "unanswered", not "denied".
  return promptedBefore ? 'blocked' : 'awaiting-permission'
}

export function useMacNotificationPermissionState(
  enabled: boolean = true
): [MacNotificationPermissionState | null, (state: MacNotificationPermissionState | null) => void] {
  const [macPermissionState, setMacPermissionState] =
    useState<MacNotificationPermissionState | null>(null)

  useEffect(() => {
    // Why: while Orca's own notifications setting is off, the OS permission
    // is irrelevant — a green "notifications are enabled" card next to a
    // disabled toggle reads as a contradiction. Hide the card and skip the
    // readout polling entirely until the setting is back on.
    if (!enabled) {
      setMacPermissionState(null)
      return
    }
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let pollAttempts = 0

    function schedulePoll(promptedBefore: boolean): void {
      if (cancelled || pollAttempts >= MAC_PROBE_POLL_MAX_ATTEMPTS) {
        return
      }
      pollTimer = setTimeout(() => {
        pollAttempts += 1
        void window.api.notifications.probeDelivery({ force: true }).then((probe) => {
          if (cancelled) {
            return
          }
          setMacPermissionState(resolveMacNotificationPermissionState(probe.state, promptedBefore))
          // Why: authoritative readouts are silent, so keep tracking System
          // Settings live in every state — flipping the toggle updates the
          // card within a poll. Probe fallbacks flash a banner when delivery
          // works, so for them polling stops once the card turns green.
          if (probe.authoritative || probe.state !== 'delivered') {
            schedulePoll(promptedBefore)
          }
        })
      }, MAC_PROBE_POLL_INTERVAL_MS)
    }

    void (async () => {
      const status = await window.api.notifications.getPermissionStatus()
      if (cancelled) {
        return
      }
      if (status.platform !== 'darwin' || !status.supported) {
        return
      }
      setMacPermissionState('checking')
      // Why: `status.requested` is read before the probe stamps it, so a
      // fresh install (where the check itself pops the macOS dialog) renders
      // as "answer the dialog" instead of "blocked" on probe-fallback hosts.
      const probe = await window.api.notifications.probeDelivery()
      if (cancelled) {
        return
      }
      const resolved = resolveMacNotificationPermissionState(probe.state, status.requested)
      setMacPermissionState(resolved)
      if (resolved !== null && (probe.authoritative || resolved !== 'enabled')) {
        schedulePoll(status.requested)
      }
    })()

    return () => {
      cancelled = true
      if (pollTimer) {
        clearTimeout(pollTimer)
      }
    }
  }, [enabled])

  return [macPermissionState, setMacPermissionState]
}

export function MacNotificationPermissionCard({
  state
}: {
  state: MacNotificationPermissionState | null
}): React.JSX.Element | null {
  if (state === 'checking') {
    return (
      <section className="rounded-xl border border-border bg-muted/20 px-5 py-4 text-[13px] text-muted-foreground">
        {translate(
          'auto.components.onboarding.NotificationStep.56b836215c',
          'Checking notification permission…'
        )}
      </section>
    )
  }

  if (state === 'enabled') {
    return (
      <section className="flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-5 py-4">
        <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {translate(
              'auto.components.onboarding.NotificationStep.fd84d3e9b8',
              'Notifications are enabled'
            )}
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.onboarding.NotificationStep.4f7bce5644',
              'macOS will alert you when agents finish or terminals need attention.'
            )}
          </p>
        </div>
      </section>
    )
  }

  if (state === 'awaiting-permission') {
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <BellRing className="size-4" />
              {translate(
                'auto.components.onboarding.NotificationStep.95d99b52fa',
                'Allow notifications for Orca'
              )}
            </div>
            <p className="max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.onboarding.mac.notification.permission.card.f696515944',
                'Click Allow in the macOS dialog.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void window.api.notifications.openSystemSettings()}
          >
            <Settings className="size-3.5" />
            {translate(
              'auto.components.onboarding.NotificationStep.4f6a1da718',
              'Open System Settings'
            )}
          </Button>
        </div>
      </section>
    )
  }

  if (state === 'blocked') {
    return (
      <section
        role="alert"
        className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
              <TriangleAlert className="size-4" />
              {translate(
                'auto.components.onboarding.NotificationStep.90b5d2e363',
                'macOS is not delivering Orca notifications'
              )}
            </div>
            <p className="max-w-[58ch] text-[13px] leading-relaxed text-amber-700/80 dark:text-amber-200/80">
              {translate(
                'auto.components.onboarding.mac.notification.permission.card.721d2bedb6',
                'Turn on Allow notifications for Orca in System Settings.'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-2"
            onClick={() => void window.api.notifications.openSystemSettings()}
          >
            <Settings className="size-3.5" />
            {translate(
              'auto.components.onboarding.NotificationStep.4f6a1da718',
              'Open System Settings'
            )}
          </Button>
        </div>
      </section>
    )
  }

  return null
}

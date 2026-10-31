import { useEffect, useState } from 'react'
import { BellRing, Check, Settings, TriangleAlert } from 'lucide-react'
import type { NotificationDeliveryProbeResult } from '../../../../shared/notification-settings-types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type MacNotificationPermissionState =
  | 'checking'
  | 'awaiting-permission'
  | 'enabled'
  | 'blocked'

const MAC_PROBE_POLL_INTERVAL_MS = 2500
// Bound polling to about three minutes so abandoned onboarding cannot probe forever.
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
  // Fallback probes trigger the first permission dialog; initial nondelivery means unanswered, not denied.
  return promptedBefore ? 'blocked' : 'awaiting-permission'
}

export function useMacNotificationPermissionState(
  enabled: boolean = true
): [MacNotificationPermissionState | null, (state: MacNotificationPermissionState | null) => void] {
  const [macPermissionState, setMacPermissionState] =
    useState<MacNotificationPermissionState | null>(null)

  useEffect(() => {
    // When app notifications are off, hide permission status and skip polling to avoid contradictory enabled feedback.
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
          // Authoritative reads are silent and keep tracking Settings; fallback probes emit banners, so stop after delivery.
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
      // Read requested before probing so fresh-install dialogs show awaiting permission instead of blocked.
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
      <section className="rounded-lg border border-border px-4 py-3.5 text-[13px] text-muted-foreground">
        {translate(
          'auto.components.onboarding.NotificationStep.56b836215c',
          'Checking notification permission…'
        )}
      </section>
    )
  }

  if (state === 'enabled') {
    return (
      <section className="flex items-start gap-3 rounded-lg border border-border px-4 py-3.5">
        <Check className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium text-foreground">
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
      <section className="rounded-lg border border-border px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <BellRing className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground">
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
      <section role="alert" className="rounded-lg border border-status-warning-border px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground">
                {translate(
                  'auto.components.onboarding.NotificationStep.90b5d2e363',
                  'macOS is not delivering Orca notifications'
                )}
              </div>
              <p className="max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.onboarding.mac.notification.permission.card.721d2bedb6',
                  'Turn on Allow notifications for Orca in System Settings.'
                )}
              </p>
            </div>
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

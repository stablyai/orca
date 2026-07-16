import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { WindowsMobileFirewallStatus } from '../../../../shared/windows-mobile-firewall'
import { useMountedRef } from '../../hooks/useMountedRef'
import { translate } from '../../i18n/i18n'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

type WindowsFirewallNoticeProps = {
  pairingReady: boolean
  address?: string
  className?: string
}

export function WindowsFirewallNotice({
  pairingReady,
  address,
  className
}: WindowsFirewallNoticeProps): React.JSX.Element | null {
  const [status, setStatus] = useState<WindowsMobileFirewallStatus | null>(null)
  const [repairing, setRepairing] = useState(false)
  const mountedRef = useMountedRef()
  const inspectIdRef = useRef(0)

  const inspect = useCallback(async (): Promise<WindowsMobileFirewallStatus | null> => {
    // Why: UAC elevation steals and returns window focus, so a focus-triggered
    // inspection can race the post-repair one; only the latest result may win.
    const inspectId = ++inspectIdRef.current
    if (!pairingReady) {
      setStatus(null)
      return null
    }
    try {
      const next = await window.api.mobile.getWindowsFirewallStatus(
        address ? { address } : undefined
      )
      if (mountedRef.current && inspectIdRef.current === inspectId) {
        setStatus(next)
      }
      return next
    } catch {
      if (mountedRef.current && inspectIdRef.current === inspectId) {
        setStatus(null)
      }
      return null
    }
  }, [address, mountedRef, pairingReady])

  useEffect(() => {
    void inspect()
    window.addEventListener('focus', inspect)
    return () => window.removeEventListener('focus', inspect)
  }, [inspect])

  if (!status?.supported) {
    return null
  }
  const firewallStatus = status
  const networkIsPublic = firewallStatus.networkCategory === 'public'
  const blockingRuleDetected = firewallStatus.blockingRuleDetected
  // Why: a Private-profile allow rule cannot help on managed domain networks.
  if (!pairingReady || firewallStatus.networkCategory === 'domain') {
    return null
  }
  if (
    !networkIsPublic &&
    (!firewallStatus.privateFirewallEnabled ||
      (firewallStatus.ruleAllowed && !blockingRuleDetected))
  ) {
    return null
  }

  async function repair(): Promise<void> {
    setRepairing(true)
    try {
      const result = await window.api.mobile.repairWindowsFirewall()
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        // Why: elevation success only confirms the script ran; managed policy
        // can still leave an overriding Block rule in effect.
        const next = await inspect()
        if (!mountedRef.current) {
          return
        }
        if (
          next?.supported &&
          (!next.privateFirewallEnabled ||
            (next.ruleAllowed && !next.blockingRuleDetected && next.inspectionAvailable))
        ) {
          toast.success(
            translate(
              'auto.components.mobile.WindowsFirewallNotice.repair-success',
              'Windows Firewall now allows Orca Mobile on private networks'
            )
          )
          return
        }
        if (!next) {
          setStatus(firewallStatus)
        }
        toast.error(
          translate(
            'auto.components.mobile.WindowsFirewallNotice.repair-unverified',
            'Windows Firewall access could not be verified'
          )
        )
        return
      }
      if (result.reason !== 'cancelled') {
        toast.error(
          translate(
            'auto.components.mobile.WindowsFirewallNotice.repair-failed',
            'Could not update the Windows Firewall rules'
          )
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.mobile.WindowsFirewallNotice.repair-failed',
            'Could not update the Windows Firewall rules'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setRepairing(false)
      }
    }
  }

  return (
    <div className={cn('rounded-lg border border-border bg-muted/40 p-3', className)}>
      <div className="flex items-start gap-2.5">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {networkIsPublic
                ? translate(
                    'auto.components.mobile.WindowsFirewallNotice.public-title',
                    'Windows marks this network as public'
                  )
                : blockingRuleDetected
                  ? translate(
                      'auto.components.mobile.WindowsFirewallNotice.blocked-title',
                      'Windows may be blocking Orca Mobile'
                    )
                  : translate(
                      'auto.components.mobile.WindowsFirewallNotice.missing-title',
                      'Allow phone connections through Windows Firewall'
                    )}
            </p>
            <p className="text-xs text-muted-foreground">
              {networkIsPublic
                ? translate(
                    'auto.components.mobile.WindowsFirewallNotice.public-description',
                    'Change this trusted Wi-Fi network to Private before allowing Orca Mobile connections.'
                  )
                : blockingRuleDetected
                  ? translate(
                      'auto.components.mobile.WindowsFirewallNotice.blocked-description',
                      'An existing inbound Block rule can override the pairing exception. Repair removes conflicting TCP rules for this Orca app, then allows port {{port}} on Private networks.',
                      { port: firewallStatus.port }
                    )
                  : translate(
                      'auto.components.mobile.WindowsFirewallNotice.missing-description',
                      'Windows may block the pairing server. Add a rule for this Orca app and TCP port {{port}} on Private networks.',
                      { port: firewallStatus.port }
                    )}
            </p>
          </div>
          {networkIsPublic ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void window.api.mobile.openWindowsNetworkSettings()}
            >
              {translate(
                'auto.components.mobile.WindowsFirewallNotice.open-settings',
                'Open network settings'
              )}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => void repair()} disabled={repairing}>
              {repairing ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              {repairing
                ? translate(
                    'auto.components.mobile.WindowsFirewallNotice.waiting',
                    'Waiting for Windows…'
                  )
                : blockingRuleDetected
                  ? translate(
                      'auto.components.mobile.WindowsFirewallNotice.repair',
                      'Repair firewall access'
                    )
                  : translate(
                      'auto.components.mobile.WindowsFirewallNotice.allow',
                      'Allow phone connections'
                    )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

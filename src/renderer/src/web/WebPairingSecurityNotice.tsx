import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { readWebDeviceKeySupport } from './web-device-key-support'
import { webPairingSecurityGuidance } from './web-pairing-security-guidance'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'

/** A small corner notice while this browser holds its pairing in a weaker form. */
export function WebPairingSecurityNotice(): React.JSX.Element | null {
  const [hidden, setHidden] = useState(false)
  const guidance = webPairingSecurityGuidance(
    readWebDeviceKeySupport(),
    readStoredWebRuntimeEnvironment()
  )
  if (hidden || !guidance) {
    return null
  }
  return (
    <div
      role="status"
      className="fixed right-3 bottom-3 z-50 flex max-w-sm items-start gap-2 rounded-lg border border-border bg-card p-3 text-xs leading-5 text-muted-foreground shadow-sm"
    >
      <ShieldAlert size={15} className="mt-0.5 shrink-0 text-foreground" aria-hidden />
      <p className="min-w-0">{guidance}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setHidden(true)}
        aria-label={translate('auto.web.pairingSecurity.hide', 'Hide')}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

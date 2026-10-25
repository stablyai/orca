import { TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SecretAtRestProtection } from '../../../../shared/secret-at-rest-protection'

/** Warn visibly about stored plaintext (#21827); current keyring capability cannot protect bytes saved before a keyring existed without resaving. */
export function UnsealedCredentialNotice({
  protection,
  credentialName
}: {
  /** Null when nothing is stored, or when the envelope could not be read. */
  protection: SecretAtRestProtection | null
  /** Named so the warning is unambiguous when a pane shows several credentials. */
  credentialName: string
}): React.JSX.Element | null {
  if (protection !== 'plaintext') {
    return null
  }
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2 text-status-warning"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 text-xs leading-snug">
        {translate(
          'auto.components.settings.UnsealedCredentialNotice.body',
          '{{credential}} is stored unencrypted — this system has no OS keyring Orca can use. Anyone who can read your disk or a backup of it can read the credential. Install and unlock gnome-keyring or kwallet, then save it again to seal it.',
          { credential: credentialName }
        )}
      </p>
    </div>
  )
}

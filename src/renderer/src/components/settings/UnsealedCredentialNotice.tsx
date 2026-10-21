import { TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SecretAtRestProtection } from '../../../../shared/secret-at-rest-protection'

/**
 * Warn that a saved credential is sitting on disk unencrypted.
 *
 * Why in Settings and not only the log: the app has always been able to describe this
 * and only ever wrote it to the main-process console, so the users it affects — a host
 * with no usable OS keyring — were told nothing where they could see it (#21827).
 *
 * Why keyed on the stored bytes and not on whether sealing works now: a credential saved
 * before a keyring existed stays plaintext until it is saved again, so capability would
 * report it protected while the file says otherwise.
 */
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

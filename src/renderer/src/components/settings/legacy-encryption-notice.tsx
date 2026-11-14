import { AlertTriangle } from 'lucide-react'

/** Shown under a paired device whose last sign-in used the older E2EE framing. */
export function LegacyEncryptionNotice({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="mt-0.5 flex items-start gap-1 text-xs text-status-warning-text">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

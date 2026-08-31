import type { PtyIdentityEvidenceNotification } from '../../../../shared/pty-identity-evidence'

export const ptyIdentityEvidenceHandlers = new Map<
  string,
  (notification: PtyIdentityEvidenceNotification) => void
>()

export function registerPtyIdentityEvidenceHandler(
  ptyId: string,
  handler: (notification: PtyIdentityEvidenceNotification) => void
): () => void {
  ptyIdentityEvidenceHandlers.set(ptyId, handler)
  return () => {
    if (ptyIdentityEvidenceHandlers.get(ptyId) === handler) {
      ptyIdentityEvidenceHandlers.delete(ptyId)
    }
  }
}

export function dispatchPtyIdentityEvidence(notification: PtyIdentityEvidenceNotification): void {
  for (const row of notification.rows) {
    ptyIdentityEvidenceHandlers.get(row.id)?.(notification)
  }
}

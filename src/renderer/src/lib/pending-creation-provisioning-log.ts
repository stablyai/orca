import { useAppStore } from '@/store'

const MAX_PROVISIONING_LOG_CHARS = 12_000

export function appendProvisioningWarnings(
  creationId: string,
  warnings: readonly { message: string; remediation?: string }[]
): void {
  if (warnings.length === 0) {
    return
  }
  const text = warnings
    .map((warning) =>
      warning.remediation
        ? `Warning: ${warning.message}\n${warning.remediation}\n`
        : `Warning: ${warning.message}\n`
    )
    .join('')
  appendProvisioningLog(creationId, text)
}

export function appendProvisioningLog(creationId: string, chunk: string): void {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  if (!entry) {
    return
  }
  // Why: recipe stdout contains the structured result with pairing credentials;
  // only stderr is displayed, and the in-memory tail is bounded.
  const nextLog = `${entry.provisioningLog ?? ''}${chunk}`.slice(-MAX_PROVISIONING_LOG_CHARS)
  store.updatePendingWorktreeCreation(creationId, { provisioningLog: nextLog })
}

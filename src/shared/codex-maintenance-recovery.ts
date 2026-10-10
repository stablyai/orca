export type CodexMaintenanceRecoveryAction =
  | { kind: 'launch' }
  | { kind: 'message'; messageId: string }
  | { kind: 'queue' }
  | { kind: 'send-again' }

export function codexMaintenanceRecoveryAction(
  launchRefused: boolean,
  cards: readonly { messageId: string; hold: string }[],
  queueResumable: boolean
): CodexMaintenanceRecoveryAction {
  if (launchRefused) {
    return { kind: 'launch' }
  }
  const retained = cards.find((card) => card.hold === 'returned' || card.hold === 'paused')
  if (retained) {
    return { kind: 'message', messageId: retained.messageId }
  }
  return { kind: queueResumable ? 'queue' : 'send-again' }
}

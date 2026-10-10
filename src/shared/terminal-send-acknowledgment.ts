/** An older host omits `writeSettlement`; its whole-write `accepted` verdict stands, as before. */
export function readTerminalSendAcknowledgment(
  result: unknown
): 'accepted' | 'refused' | 'unverifiable' {
  if (typeof result !== 'object' || result === null || !('send' in result)) {
    return 'unverifiable'
  }
  const send = result.send
  if (typeof send !== 'object' || send === null) {
    return 'unverifiable'
  }
  if ('writeSettlement' in send) {
    const settlement = send.writeSettlement
    if (typeof settlement === 'object' && settlement !== null && 'outcome' in settlement) {
      if (settlement.outcome === 'refused') {
        return 'refused'
      }
      if (settlement.outcome === 'accepted' && 'accepted' in send && send.accepted === true) {
        return 'accepted'
      }
    }
    return 'unverifiable'
  }
  if ('accepted' in send) {
    if (send.accepted === true) {
      return 'accepted'
    }
    if (send.accepted === false) {
      return 'refused'
    }
  }
  return 'unverifiable'
}

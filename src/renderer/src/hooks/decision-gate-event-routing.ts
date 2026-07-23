type DecisionGateChangeEvent = {
  gateId?: string
  question?: string
  resolvedGateId?: string
}

type DecisionGateNotifications = Pick<Window['api']['notifications'], 'dispatch' | 'dismiss'>

export function routeDecisionGateChange(
  event: DecisionGateChangeEvent,
  notifications: DecisionGateNotifications,
  emitChanged: (event: DecisionGateChangeEvent) => void
): void {
  if (event.gateId && event.question) {
    void notifications.dispatch({
      source: 'orchestration-attention',
      notificationId: event.gateId,
      gateId: event.gateId,
      question: event.question
    })
  }
  if (event.resolvedGateId) {
    void notifications.dismiss([event.resolvedGateId])
  }
  emitChanged(event)
}

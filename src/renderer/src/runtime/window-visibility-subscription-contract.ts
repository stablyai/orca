export type WindowVisibilitySubscriptionContext = {
  visibilityGeneration: number
}

export type WindowVisibilitySubscriptionSpec = {
  subscribe: (
    isCurrent: () => boolean,
    context: WindowVisibilitySubscriptionContext
  ) => Promise<{ unsubscribe: () => void }>
  onSubscribeError?: (error: unknown) => void
  onUnsubscribeError?: (error: unknown) => void
  onRestart?: (context: WindowVisibilitySubscriptionContext) => void
}

export type WindowVisibilitySubscriptionParkingOptions = {
  getVisibilityResumePriority?: (specIndex: number) => number
  parkDelayMs?: number
  visibilityResumeStaggerMs?: number
  onVisibilityResume?: (args: {
    visibilityGeneration: number
    restartingSpecIndexes: readonly number[]
  }) => void
}

export type WindowVisibilitySubscriptionParking = {
  dispose: () => void
  restart: (specIndexes: readonly number[]) => void
}

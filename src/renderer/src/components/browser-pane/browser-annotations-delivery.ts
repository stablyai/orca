/**
 * Side effects after browser Design Mode annotations are delivered to an agent.
 *
 * Why: matches diff/markdown review notes — once feedback is in the agent chat,
 * keep the live page/tray clean. Chat history remains the source of truth.
 */
export function applyBrowserAnnotationsDeliveredToAgent(args: {
  pageId: string
  clearBrowserPageAnnotations: (pageId: string) => void
  recordFeatureInteraction: (featureId: 'browser-annotations-sent-to-agent') => void
  /** Local tray UI only (copied state, timers). Not persisted store state. */
  resetLocalUiState?: () => void
}): void {
  args.recordFeatureInteraction('browser-annotations-sent-to-agent')
  args.resetLocalUiState?.()
  args.clearBrowserPageAnnotations(args.pageId)
}

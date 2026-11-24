/** `orca plugin open` / `shot`: main asks this window to show a plugin view and answers it. */
export function registerPluginViewIpcBridge(unsubs: (() => void)[]): void {
  const plugins = window.api?.plugins
  if (!plugins?.onViewRequest || !plugins.answerViewRequest) {
    return
  }
  const answer = plugins.answerViewRequest
  unsubs.push(
    plugins.onViewRequest((request) => {
      // Lazy: the handler pulls in plugin stores most sessions never need.
      void import('@/components/plugins/view/plugin-view-request-handler')
        .then(({ handlePluginViewRequest }) => handlePluginViewRequest(request))
        .then(answer, (error: unknown) =>
          answer({
            requestId: request.requestId,
            ok: false,
            code: 'renderer_error',
            message: error instanceof Error ? error.message : String(error)
          })
        )
    })
  )
}

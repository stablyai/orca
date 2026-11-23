export function observeBrowserClientPageBootstrap(
  webview: Electron.WebviewTag,
  isAttaching: () => boolean,
  ready: () => void
): () => void {
  let finished = false
  const onFinished = (): void => {
    finished = true
  }
  const onStopped = (): void => {
    if (finished && isAttaching()) {
      ready()
    }
  }
  webview.addEventListener('did-finish-load', onFinished)
  webview.addEventListener('did-stop-loading', onStopped)
  return () => {
    webview.removeEventListener('did-finish-load', onFinished)
    webview.removeEventListener('did-stop-loading', onStopped)
  }
}

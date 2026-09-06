import { PierreDiffWorkerPoolProvider } from './pierre-diff-worker-pool'
import { PierreDiffEditProvider } from './pierre-diff-editor-provider'

/**
 * Wraps a diff surface with the Shiki worker pool and the editor factory.
 *
 * Requires @pierre/diffs >= 1.4.0. In 1.3.6 nothing rendered under React
 * StrictMode: the shadow DOM was never committed on the remount, so every diff
 * was blank in dev. Do not downgrade below 1.4.
 */
export function PierreDiffProviders({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <PierreDiffWorkerPoolProvider>
      <PierreDiffEditProvider>{children}</PierreDiffEditProvider>
    </PierreDiffWorkerPoolProvider>
  )
}

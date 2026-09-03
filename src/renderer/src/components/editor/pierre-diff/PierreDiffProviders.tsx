import { PierreDiffWorkerPoolProvider } from './pierre-diff-worker-pool'
import { PierreDiffEditProvider } from './pierre-diff-editor-provider'

/**
 * Wraps a diff surface with the Shiki worker pool and the editor factory.
 *
 * KNOWN BLOCKER: @pierre/diffs 1.3.6 does not survive React StrictMode's
 * mount/unmount/mount. Its shadow DOM is never committed on the second mount,
 * so every diff renders blank in dev. Verified by toggling StrictMode alone,
 * with and without the worker pool. Production builds do not run StrictMode.
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

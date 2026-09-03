import { PierreDiffWorkerPoolProvider } from './pierre-diff-worker-pool'
import { PierreDiffEditProvider } from './pierre-diff-editor-provider'

/**
 * Wraps a diff surface with the Shiki worker pool and the editor factory.
 * Pierre reference-counts the pool, so every diff view can mount this and they
 * still share one set of workers.
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

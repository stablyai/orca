import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { usePluginShotReplayStore } from '@/store/plugin-shot-replay'

// Lazy: the declarative view is only needed while a `shot --scenario` capture runs.
const PluginShotReplaySurface = lazy(() => import('./PluginShotReplaySurface'))

export function PluginShotReplayMount(): React.JSX.Element | null {
  const preview = usePluginShotReplayStore((state) => state.preview)
  return preview ? (
    <Suspense fallback={null}>
      <PluginShotReplaySurface preview={preview} />
    </Suspense>
  ) : null
}

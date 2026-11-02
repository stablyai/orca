import { Suspense, type ComponentProps } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import type { OrchestrationCrewPanel as Panel } from './OrchestrationCrewPanel'

// Loaded on first mount, so a user who never turns the experimental panel on never loads its code.
const OrchestrationCrewPanel = lazy(() =>
  import('./OrchestrationCrewPanel').then((module) => ({ default: module.OrchestrationCrewPanel }))
)

export function LazyOrchestrationCrewPanel(props: ComponentProps<typeof Panel>): React.JSX.Element {
  // The panel overlays a chat or terminal; if it can't load, the pane keeps working without it.
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="orchestration-panel"
      surface="overlay"
      fallback={() => null}
    >
      <Suspense fallback={null}>
        <OrchestrationCrewPanel {...props} />
      </Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

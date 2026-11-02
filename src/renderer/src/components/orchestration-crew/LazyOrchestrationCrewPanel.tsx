import { lazy, Suspense, type ComponentProps } from 'react'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import type { OrchestrationCrewPanel as Panel } from './OrchestrationCrewPanel'

// Loaded on first mount, so a user who never turns the experimental panel on never loads its code.
// Plain lazy, not the app's reloading retry: a failed load just leaves this optional overlay out.
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

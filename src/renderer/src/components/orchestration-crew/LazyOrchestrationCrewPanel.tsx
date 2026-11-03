import { lazy, Suspense, useState, type ComponentProps } from 'react'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import type { OrchestrationCrewPanel as Panel } from './OrchestrationCrewPanel'

// Loaded on first mount, so a user who never turns the experimental panel on never loads its code.
// No background retry or reload: a failed load is dropped, and the next mount tries once more.
function lazyPanel() {
  const component = lazy(() =>
    import('./OrchestrationCrewPanel')
      .then((module) => ({ default: module.OrchestrationCrewPanel }))
      .catch((error: unknown) => {
        // React.lazy keeps a rejection forever; a fresh one lets turning the setting back on load again.
        if (current === component) {
          current = lazyPanel()
        }
        throw error
      })
  )
  return component
}
let current = lazyPanel()

export function LazyOrchestrationCrewPanel(props: ComponentProps<typeof Panel>): React.JSX.Element {
  // Pinned per mount, so a later replacement never remounts a panel that is already showing.
  const [LoadedPanel] = useState(() => current)
  // The panel overlays a chat or terminal; if it can't load, the pane keeps working without it.
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="orchestration-panel"
      surface="overlay"
      fallback={() => null}
    >
      <Suspense fallback={null}>
        <LoadedPanel {...props} />
      </Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import { applyDocumentTheme } from './lib/document-theme'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'

if (
  import.meta.env.DEV &&
  shouldEnableReactGrab({
    dev: import.meta.env.DEV,
    enableFlag: import.meta.env.VITE_ENABLE_REACT_GRAB
  })
) {
  void import('react-grab').then(({ init }) => init())
  void import('react-grab/styles.css')
}

applyDocumentTheme('system', { disableTransitions: false })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title="Orca hit a renderer error."
      description="The app shell could not finish rendering. Retry to remount it, or relaunch Orca if the error persists."
    >
      <App />
    </RecoverableRenderErrorBoundary>
  </StrictMode>
)

// Why first, and why the import-free shim: react-dom reads
// __REACT_DEVTOOLS_GLOBAL_HOOK__ once at module evaluation, so the global has to
// exist before it.
import './lib/react-devtools-commit-hook-shim'
import './assets/main.css'

import { StrictMode } from 'react'
import { DesktopPetRoot } from './components/pet/DesktopPetRoot'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from './lib/crash-diagnostics'
import { getOrCreateRendererRoot } from './lib/react-renderer-root'

// Why: the detached pet is a separate BrowserWindow with its own React root, so it runs its own
// renderer bootstrap. It deliberately skips theme/i18n: the pet is a transparent sprite with no
// chrome and no copy, so there is nothing for either to style or translate.
recordRendererCrashBreadcrumb('desktop_pet_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics('desktop-pet')

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('desktop_pet_root_missing')
  throw new Error('Desktop pet root element not found.')
}

getOrCreateRendererRoot(rootElement, import.meta.hot?.data).render(
  <StrictMode>
    <RecoverableRenderErrorBoundary boundaryId="desktop-pet.root" surface="desktop-pet">
      <DesktopPetRoot />
    </RecoverableRenderErrorBoundary>
  </StrictMode>
)
recordRendererCrashBreadcrumb('desktop_pet_bootstrap_rendered')
